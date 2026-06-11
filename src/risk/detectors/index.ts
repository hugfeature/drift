/**
 * Risk Layer v0.1+v0.2 — Unified detector runner
 * Runs all detectors over full event stream per RFC §6 + Appendix B.
 */

import type { NormalizedEvent, PrimarySignal } from '../types'
import { detectStaleContext } from './stale-context'
import { detectRetryDensity } from './retry-density'
import { detectTrajectoryDivergence } from './trajectory-divergence'
import { detectCompletionCoverageGap } from './completion-coverage'
import { detectAssertionWithoutVerification } from './assertion-without-verification'
import { detectObligationClosure } from './obligation-closure'
import { detectRepairCycle } from './repair-cycle'
import { detectPrematureCompletion } from './premature-completion'
import { detectConstraintViolation } from './constraint-violation'
import { detectGoalEnumerationCoverage } from './goal-enumeration-coverage'
import { detectGoalAbandonment } from './goal-abandonment'

export { detectStaleContext } from './stale-context'
export { detectRetryDensity } from './retry-density'
export { detectTrajectoryDivergence, inferExpectedDomain } from './trajectory-divergence'
export { detectCompletionCoverageGap, extractQuantityConstraints } from './completion-coverage'
export { detectAssertionWithoutVerification } from './assertion-without-verification'
export { detectObligationClosure } from './obligation-closure'
export { detectRepairCycle, computeRepairCycleScore } from './repair-cycle'
export { detectPrematureCompletion } from './premature-completion'
export { detectConstraintViolation } from './constraint-violation'
export { detectGoalEnumerationCoverage } from './goal-enumeration-coverage'
export { detectGoalAbandonment } from './goal-abandonment'

/**
 * Run all primary signal detectors over the full event stream.
 * Per RFC: detectors run on FULL stream, signals are later partitioned into windows.
 *
 * @param promptText - First user message, used by completion_coverage_gap detector
 */
export function runAllDetectors(
  events: NormalizedEvent[],
  goalText: string | undefined,
  promptText?: string,
): PrimarySignal[] {
  const signals: PrimarySignal[] = [
    ...detectStaleContext(events),
    ...detectRetryDensity(events),
    ...detectTrajectoryDivergence(events, goalText),
    ...detectCompletionCoverageGap(events, promptText),
    ...detectAssertionWithoutVerification(events),
    ...detectObligationClosure(events),
    ...detectRepairCycle(events),
    ...detectPrematureCompletion(events, goalText),
    ...detectConstraintViolation(events, goalText),
    ...detectGoalEnumerationCoverage(events, goalText),
    ...detectGoalAbandonment(events),
  ]

  return signals.sort((a, b) => {
    const indexA = getSignalSortIndex(a)
    const indexB = getSignalSortIndex(b)
    return indexA - indexB
  })
}

function getSignalSortIndex(signal: PrimarySignal): number {
  switch (signal.signal) {
    case 'stale_context': return signal.action_index
    case 'retry_density': return signal.window_start
    case 'trajectory_divergence': return signal.window_start
    case 'completion_coverage_gap': return signal.completion_event_index
    case 'assertion_without_verification': return signal.assertion_event_index
    case 'obligation_closure_check': return signal.first_registration_index
    case 'repair_cycle_density': return signal.first_edit_index
    case 'premature_completion_claim': return signal.completion_event_index
    case 'constraint_violation': return signal.first_write_index
    case 'goal_enumeration_coverage': return 0
    case 'goal_abandonment': return signal.first_unrelated_index
  }
}
