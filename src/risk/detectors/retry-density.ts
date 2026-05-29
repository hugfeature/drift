/**
 * retry_density detector — local recovery collapse
 * Per RFC §4: sliding window of 5 events, count events matching same retry key.
 * Fires when count ≥ 3. Events need not be consecutive.
 *
 * v0.1 adaptation: outcome fields are absent in 99.6% of events, so retry
 * is detected by repetition itself — same_tool + same_message/target appearing
 * multiple times IS evidence of failed/no_progress (an agent that succeeded
 * would not repeat the identical call).
 *
 * Retry key hierarchy:
 *   1. same_tool + same_target (when target extractable)
 *   2. same_tool + same_message (exact message match, for Bash/exec)
 *   3. explicit outcome=failed + same_tool (original RFC rule)
 */

import type { NormalizedEvent, RetryDensitySignal, RawFixtureEvent } from '../types'

const WINDOW_SIZE = 5
const RETRY_THRESHOLD = 3

/**
 * Augmented event with original message for retry key matching.
 * We need the raw message to detect same-message retries.
 */
export interface RetryAugmentedEvent extends NormalizedEvent {
  raw_message?: string
}

/** Build a canonical retry key. Returns undefined if not eligible. */
function retryKey(event: RetryAugmentedEvent): string | undefined {
  // Strategy 1: explicit failure + tool
  if ((event.outcome === 'failed' || event.outcome === 'no_progress') && event.tool_name !== 'unknown') {
    return `outcome::${event.tool_name}::${event.tool_target ?? ''}`
  }

  // Strategy 2: same_tool + same_target (structural repetition)
  if (event.tool_target) {
    return `target::${event.tool_name}::${event.tool_target}`
  }

  // Strategy 3: same_tool + same_message (for Bash/exec where target extraction fails)
  if (event.raw_message && event.raw_message.length > 5) {
    return `message::${event.tool_name}::${event.raw_message}`
  }

  return undefined
}

/**
 * Detect retry_density signals across the full event stream.
 * Uses sliding window of WINDOW_SIZE events.
 */
export function detectRetryDensity(events: RetryAugmentedEvent[]): RetryDensitySignal[] {
  const signals: RetryDensitySignal[] = []

  if (events.length < WINDOW_SIZE) return signals

  for (let windowStart = 0; windowStart <= events.length - WINDOW_SIZE; windowStart++) {
    const windowEnd = windowStart + WINDOW_SIZE - 1

    // Count retry keys in this window
    const keyCounts = new Map<string, number>()
    for (let i = windowStart; i <= windowEnd; i++) {
      const key = retryKey(events[i])
      if (key) {
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
      }
    }

    // Check if any retry key meets threshold
    for (const [, count] of keyCounts) {
      if (count >= RETRY_THRESHOLD) {
        const isDuplicate = signals.some(
          existing =>
            existing.window_end >= windowStart &&
            existing.window_start <= windowEnd,
        )
        if (!isDuplicate) {
          signals.push({
            signal: 'retry_density',
            count,
            window_start: windowStart,
            window_end: windowEnd,
          })
        }
        break
      }
    }
  }

  return signals
}
