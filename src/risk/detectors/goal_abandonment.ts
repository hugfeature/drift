/**
 * goal_abandonment detector — v0.2 Signal 11
 *
 * Detects when an agent starts working on a goal (aligned events), then
 * switches entirely to unrelated work without ever declaring completion.
 *
 * This is distinct from:
 *   - completion_coverage_gap: agent *claims* completion but didn't verify
 *   - premature_completion_claim: agent claims "done" too early
 *   - goal_abandonment: agent *never even claims* completion — just walks away
 *
 * Pattern:
 *   1. Session starts with N aligned events (establishing goal engagement)
 *   2. Followed by M consecutive unrelated events until session end
 *   3. No completion declaration found anywhere in the stream
 *
 * Targets: fixture_iw9naxht (goal_forgotten/interruption_induced: auth fix → deployment)
 */

import type { NormalizedEvent } from '../types'

export interface GoalAbandonmentSignal {
  signal: 'goal_abandonment'
  /** Event index where the last aligned action occurred */
  last_aligned_index: number
  /** Event index where the first unrelated action started */
  first_unrelated_index: number
  /** Number of aligned events before abandonment */
  aligned_count: number
  /** Number of trailing unrelated events */
  trailing_unrelated_count: number
  /** Total events in the session */
  total_events: number
}

/**
 * Minimum aligned events required before we consider the agent "engaged"
 * with the goal. Too low → false positives on sessions that never started.
 */
const MIN_ALIGNED_ENGAGEMENT = 2

/**
 * Minimum consecutive unrelated events at the tail to consider it
 * "abandoned". Must be long enough to rule out brief tangents.
 */
const MIN_TRAILING_UNRELATED = 3

/**
 * Completion keywords — if any event message contains these, the agent
 * at least *tried* to declare completion (even if premature/wrong).
 * Reused from premature-completion detector patterns.
 */
const COMPLETION_PATTERNS = [
  /已完成/,
  /任务完成/,
  /全部完成/,
  /完成了/,
  /搞定了/,
  /做完了/,
  /\b(?:task|work|implementation)\s+(?:is\s+)?(?:complete|done|finished)\b/i,
  /\b(?:I've|I have)\s+(?:completed|finished|done)\b/i,
  /\ball\s+(?:done|complete|finished)\b/i,
  /\bsuccessfully\s+(?:completed|implemented|finished)\b/i,
]

function hasCompletionDeclaration(events: NormalizedEvent[]): boolean {
  return events.some(event => {
    const message = event.raw_message ?? ''
    return COMPLETION_PATTERNS.some(pattern => pattern.test(message))
  })
}

/**
 * Detect goal abandonment: aligned start → unrelated tail, no completion.
 *
 * Fires at most once per session.
 */
export function detectGoalAbandonment(events: NormalizedEvent[]): GoalAbandonmentSignal[] {
  if (events.length < MIN_ALIGNED_ENGAGEMENT + MIN_TRAILING_UNRELATED) {
    return []
  }

  // Count aligned events from the start (allowing minor gaps)
  let lastAlignedIndex = -1
  let alignedCount = 0
  for (let i = 0; i < events.length; i++) {
    const relation = events[i].goal_relation
    if (relation === 'aligned' || relation === 'refinement') {
      lastAlignedIndex = i
      alignedCount++
    }
  }

  if (alignedCount < MIN_ALIGNED_ENGAGEMENT) {
    return []
  }

  // Find the trailing unrelated streak from the end
  let trailingUnrelatedCount = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const relation = events[i].goal_relation
    if (relation === 'unrelated' || relation === 'expansion') {
      trailingUnrelatedCount++
    } else {
      break
    }
  }

  if (trailingUnrelatedCount < MIN_TRAILING_UNRELATED) {
    return []
  }

  const firstUnrelatedIndex = events.length - trailingUnrelatedCount

  // The aligned work must come *before* the trailing unrelated block.
  // If all aligned events are after the unrelated block starts, this is
  // not an abandonment pattern (it's something else entirely).
  if (lastAlignedIndex >= firstUnrelatedIndex) {
    return []
  }

  // If the agent declared completion at any point, this is not abandonment
  // — it's a premature-completion or coverage-gap issue instead.
  if (hasCompletionDeclaration(events)) {
    return []
  }

  return [{
    signal: 'goal_abandonment',
    last_aligned_index: lastAlignedIndex,
    first_unrelated_index: firstUnrelatedIndex,
    aligned_count: alignedCount,
    trailing_unrelated_count: trailingUnrelatedCount,
    total_events: events.length,
  }]
}
