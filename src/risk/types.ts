/**
 * Risk Annotation Layer v0.1 — Type definitions
 * Per RFC: docs/rfc-risk-layer-v0.1.md
 */

export type Domain =
  | 'code'
  | 'read'
  | 'test'
  | 'filesystem'
  | 'git'
  | 'browser'
  | 'task_mgmt'
  | 'unknown'

export type SignalOutcome = 'success' | 'failed' | 'no_progress' | 'unknown'

export interface NormalizedEvent {
  index: number
  timestamp: number
  tool_name: string
  tool_target?: string
  domain: Domain
  goal_relation?: 'aligned' | 'refinement' | 'expansion' | 'unrelated'
  relation_confidence?: number
  is_refresh: boolean
  outcome: SignalOutcome
  /** Original message/command text, used for retry key matching */
  raw_message?: string
}

export interface StaleContextSignal {
  signal: 'stale_context'
  stale_gap: number
  observation_index: number
  action_index: number
}

export interface RetryDensitySignal {
  signal: 'retry_density'
  count: number
  window_start: number
  window_end: number
}

export interface TrajectoryDivergenceSignal {
  signal: 'trajectory_divergence'
  dominant_domain: Domain
  expected_domain: Domain
  persistence: number
  window_start: number
}

export interface CompletionCoverageGapSignal {
  signal: 'completion_coverage_gap'
  /** Event index where completion was declared */
  completion_event_index: number
  /** Quantity constraints extracted from prompt */
  prompt_constraints: PromptQuantityConstraint[]
  /** Actual output count detected */
  actual_output_count: number
  /** Expected output count from prompt */
  expected_output_count: number
}

export interface PromptQuantityConstraint {
  /** Raw text matched (e.g. "两篇", "3 files") */
  raw_match: string
  /** Numeric value extracted */
  quantity: number
  /** Optional entity type (e.g. "篇", "个", "files") */
  unit?: string
}

export interface AssertionWithoutVerificationSignal {
  signal: 'assertion_without_verification'
  assertion_event_index: number
  claimed_resource: string
  assertion_text: string
  user_corrected: boolean
  confidence: 'high' | 'medium' | 'low'
}

export interface ObligationClosureSignal {
  signal: 'obligation_closure_check'
  first_registration_index: number
  obligation_type: string
  required_obligations: string[]
  fulfilled_obligations: string[]
  missing_obligations: string[]
  completion_ratio: number
}

export type PrimarySignal =
  | StaleContextSignal
  | RetryDensitySignal
  | TrajectoryDivergenceSignal
  | CompletionCoverageGapSignal
  | AssertionWithoutVerificationSignal
  | ObligationClosureSignal

export interface ExecutionLengthFeature {
  feature: 'execution_length'
  value: number
}

export type TrajectoryRisk = 'HIGH' | 'MEDIUM' | 'LOW'

export interface RiskAnnotation {
  case_id: string
  total_events: number
  failure_point_index: number
  risk_window_signals: PrimarySignal[]
  baseline_window_signals: PrimarySignal[]
  trajectory_risk: TrajectoryRisk
  execution_length: ExecutionLengthFeature
}

/** Raw fixture event as found in session.events[] */
export interface RawFixtureEvent {
  id: string
  timestamp: number
  type?: string
  source?: string
  goal_id?: string
  goal_relation?: string
  relation_confidence?: number
  drift_score_at_event?: number
  payload?: {
    tool_name?: string
    message?: string
    command?: string
    [key: string]: unknown
  }
  _turn_index?: number
  _turn_prompt?: string
}

/** Raw fixture top-level structure (union of both schemas) */
export interface RawFixture {
  id?: string
  case_id?: string
  description?: string
  session?: {
    id: string
    events: RawFixtureEvent[]
    goals?: Array<{
      id: string
      raw?: string
      normalized?: { observable_targets?: string[]; allowed_domains?: string[] }
      status?: string
    }>
    active_goal_id?: string
  }
  label?: {
    drift?: boolean
    session_trigger_type?: string
    failure_chain?: {
      recovery_attempted?: boolean
      cross_session?: Record<string, unknown>
    }
    [key: string]: unknown
  }
  failure_chain?: {
    root_failure?: {
      event_refs?: string[]
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  recovery?: {
    attempted?: boolean
    [key: string]: unknown
  }
}
