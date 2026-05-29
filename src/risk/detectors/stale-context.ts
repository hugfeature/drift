/**
 * stale_context detector — memory validity collapse
 * Per RFC §4: observation → ≥5 non-refresh gap events → action on same target, no valid refresh.
 * Refresh is valid ONLY when refresh target overlaps previously observed target.
 */

import type { NormalizedEvent, StaleContextSignal } from '../types'

const STALE_GAP_THRESHOLD = 5

/** Mutating tool names — actions that operate on state */
const MUTATING_DOMAINS = new Set(['code'])
const MUTATING_TOOLS = new Set([
  'Edit', 'Write', 'edit', 'write', 'edit_file',
])

function isMutatingEvent(event: NormalizedEvent): boolean {
  if (MUTATING_TOOLS.has(event.tool_name)) return true
  if (event.domain === 'code' && event.tool_name === 'Bash') return true
  return false
}

function isObservationEvent(event: NormalizedEvent): boolean {
  return event.domain === 'read'
}

/**
 * Detect stale_context signals across the full event stream.
 * For each observation with a target, scan forward for a mutating action
 * on the same target with ≥ STALE_GAP_THRESHOLD non-refresh events between.
 */
export function detectStaleContext(events: NormalizedEvent[]): StaleContextSignal[] {
  const signals: StaleContextSignal[] = []

  for (let observationIndex = 0; observationIndex < events.length; observationIndex++) {
    const observation = events[observationIndex]
    if (!isObservationEvent(observation) || !observation.tool_target) continue

    const target = observation.tool_target
    let gapCount = 0
    let refreshedSinceObservation = false

    for (let actionIndex = observationIndex + 1; actionIndex < events.length; actionIndex++) {
      const candidate = events[actionIndex]

      // Check if this event refreshes the same target
      if (candidate.is_refresh && candidate.tool_target === target) {
        refreshedSinceObservation = true
        // Reset: this becomes a new observation point
        break
      }

      // Check if this is a mutating action on the same target
      if (isMutatingEvent(candidate) && candidate.tool_target === target) {
        if (!refreshedSinceObservation && gapCount >= STALE_GAP_THRESHOLD) {
          signals.push({
            signal: 'stale_context',
            stale_gap: gapCount,
            observation_index: observationIndex,
            action_index: actionIndex,
          })
        }
        break
      }

      // Count non-refresh gap events
      if (!candidate.is_refresh || candidate.tool_target !== target) {
        gapCount++
      }
    }
  }

  return signals
}
