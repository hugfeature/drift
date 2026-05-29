/**
 * trajectory_divergence detector — global intent drift
 * Per RFC §4: sliding window of 5 events, detect persistent dominant domain
 * emergence (≥3 consecutive) that diverges from expected domain for active goal.
 * Does NOT detect domain widening — only persistent takeover.
 */

import type { Domain, NormalizedEvent, TrajectoryDivergenceSignal } from '../types'

const WINDOW_SIZE = 5
const PERSISTENCE_THRESHOLD = 3

/**
 * Infer expected domain from goal text.
 * v0.1 uses conservative keyword heuristics.
 */
export function inferExpectedDomain(goalText: string | undefined): Domain | undefined {
  if (!goalText) return undefined

  const lower = goalText.toLowerCase()

  if (/\b(test|spec|jest|pytest|coverage|qa)\b/.test(lower)) return 'test'
  if (/\b(git|commit|branch|merge|pr|pull\s*request)\b/.test(lower)) return 'git'
  if (/\b(deploy|build|ci|cd|pipeline)\b/.test(lower)) return 'code'
  if (/\b(fix|bug|error|issue|debug|patch)\b/.test(lower)) return 'code'
  if (/\b(write|implement|create|add|feature|refactor)\b/.test(lower)) return 'code'
  if (/\b(read|check|review|inspect|investigate|look|verify)\b/.test(lower)) return 'read'
  if (/\b(task|plan|todo|status|progress|update)\b/.test(lower)) return 'task_mgmt'
  if (/\b(browse|fetch|url|web|page|navigate)\b/.test(lower)) return 'browser'

  return undefined
}

/**
 * Find the longest run of consecutive events with the same domain
 * within a window of events.
 */
function findDominantRun(
  events: NormalizedEvent[],
  windowStart: number,
  windowEnd: number,
): { domain: Domain; persistence: number; startIndex: number } | undefined {
  let bestDomain: Domain | undefined
  let bestLength = 0
  let bestStart = windowStart

  let currentDomain: Domain | undefined
  let currentLength = 0
  let currentStart = windowStart

  for (let i = windowStart; i <= windowEnd; i++) {
    const domain = events[i].domain
    if (domain === 'unknown') {
      // unknown doesn't count toward any run
      currentDomain = undefined
      currentLength = 0
      continue
    }

    if (domain === currentDomain) {
      currentLength++
    } else {
      currentDomain = domain
      currentLength = 1
      currentStart = i
    }

    if (currentLength > bestLength) {
      bestLength = currentLength
      bestDomain = currentDomain
      bestStart = currentStart
    }
  }

  if (bestDomain && bestLength >= PERSISTENCE_THRESHOLD) {
    return { domain: bestDomain, persistence: bestLength, startIndex: bestStart }
  }
  return undefined
}

/**
 * Detect trajectory_divergence signals across the full event stream.
 * Requires goal information to determine expected domain.
 */
export function detectTrajectoryDivergence(
  events: NormalizedEvent[],
  goalText: string | undefined,
): TrajectoryDivergenceSignal[] {
  const expectedDomain = inferExpectedDomain(goalText)
  if (!expectedDomain) return [] // Cannot detect divergence without expected domain

  const signals: TrajectoryDivergenceSignal[] = []

  if (events.length < WINDOW_SIZE) return signals

  for (let windowStart = 0; windowStart <= events.length - WINDOW_SIZE; windowStart++) {
    const windowEnd = windowStart + WINDOW_SIZE - 1

    const dominantRun = findDominantRun(events, windowStart, windowEnd)
    if (!dominantRun) continue
    if (dominantRun.domain === expectedDomain) continue // Not divergent

    // Avoid duplicate signals for overlapping windows with same dominant run
    const isDuplicate = signals.some(
      existing =>
        existing.dominant_domain === dominantRun.domain &&
        Math.abs(existing.window_start - windowStart) < PERSISTENCE_THRESHOLD,
    )
    if (isDuplicate) continue

    signals.push({
      signal: 'trajectory_divergence',
      dominant_domain: dominantRun.domain,
      expected_domain: expectedDomain,
      persistence: dominantRun.persistence,
      window_start: dominantRun.startIndex,
    })
  }

  return signals
}
