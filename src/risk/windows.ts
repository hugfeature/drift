/**
 * Risk Layer v0.1 — Window extraction
 * Per RFC §3.2 + §6: failure_point_index, risk window, baseline rolling windows.
 *
 * Detectors run over the FULL event stream, then signals are assigned
 * to risk_window or baseline_windows by their firing index.
 */

import type { NormalizedEvent, PrimarySignal } from './types'

export interface WindowConfig {
  /** Number of events in the risk window (3 or 5) */
  windowSize: number
}

export interface WindowResult {
  /** Index of the failure point (default: last event) */
  failurePointIndex: number
  /** Risk window: [failurePointIndex - N, failurePointIndex) */
  riskWindowStart: number
  riskWindowEnd: number
  /** All baseline windows of same size before the risk window */
  baselineWindows: Array<{ start: number; end: number }>
}

/**
 * Determine failure_point_index.
 * Per RFC: last event in session unless explicitly annotated.
 */
export function determineFailurePoint(events: NormalizedEvent[]): number {
  return events.length - 1
}

/**
 * Extract risk window and baseline rolling windows.
 * Per RFC: baseline uses all earlier N-sized windows, not one unbounded prefix.
 */
export function extractWindows(
  events: NormalizedEvent[],
  config: WindowConfig,
): WindowResult {
  const failurePointIndex = determineFailurePoint(events)
  const windowSize = config.windowSize

  const riskWindowStart = Math.max(0, failurePointIndex - windowSize)
  const riskWindowEnd = failurePointIndex

  // Generate all N-sized baseline windows before the risk window
  const baselineWindows: Array<{ start: number; end: number }> = []
  for (let start = 0; start + windowSize <= riskWindowStart; start++) {
    baselineWindows.push({
      start,
      end: start + windowSize,
    })
  }

  return {
    failurePointIndex,
    riskWindowStart,
    riskWindowEnd,
    baselineWindows,
  }
}

/**
 * Assign a signal to risk_window or baseline_windows by its firing index.
 * Per RFC: stale_context uses action_index; retry_density/trajectory_divergence use window_end/window_start.
 */
export function getSignalFiringIndex(signal: PrimarySignal): number {
  switch (signal.signal) {
    case 'stale_context':
      return signal.action_index
    case 'retry_density':
      return signal.window_end
    case 'trajectory_divergence':
      return signal.window_start + signal.persistence - 1
    case 'completion_coverage_gap':
      return signal.completion_event_index
    case 'assertion_without_verification':
      return signal.assertion_event_index
    case 'obligation_closure_check':
      return signal.first_registration_index
    case 'repair_cycle_density':
      return signal.last_edit_index
    case 'premature_completion_claim':
      return signal.completion_event_index
    case 'constraint_violation':
      return signal.first_write_index
    case 'goal_enumeration_coverage':
      return 0
    case 'goal_abandonment':
      return signal.first_unrelated_index
  }
}

/**
 * Partition signals into risk_window vs baseline_window groups.
 * Signals are emitted from FULL stream, then assigned by firing index.
 */
export function partitionSignals(
  signals: PrimarySignal[],
  windowResult: WindowResult,
): { riskSignals: PrimarySignal[]; baselineSignals: PrimarySignal[] } {
  const riskSignals: PrimarySignal[] = []
  const baselineSignals: PrimarySignal[] = []

  for (const signal of signals) {
    const firingIndex = getSignalFiringIndex(signal)
    if (
      firingIndex >= windowResult.riskWindowStart &&
      firingIndex <= windowResult.riskWindowEnd
    ) {
      riskSignals.push(signal)
    } else if (firingIndex < windowResult.riskWindowStart) {
      baselineSignals.push(signal)
    }
    // Signals after failure point are discarded (shouldn't exist)
  }

  return { riskSignals, baselineSignals }
}
