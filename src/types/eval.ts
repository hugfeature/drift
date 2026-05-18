/**
 * Eval types for Drift benchmarking.
 *
 * Critical: eval data must be real agent sessions, not synthetic.
 * Runtime weirdness cannot be fabricated.
 * Even 10 real labeled sessions are worth more than 100 fake traces.
 *
 * Label schema captures when drift happened, not just whether it happened.
 * 'drift_started_at' is more valuable than 'drift: true'.
 */

import type { AgentType, Session } from './session'

export type DriftType =
  | 'scope_expansion'           // agent expanded beyond allowed_domains
  | 'goal_forgotten'            // original goal inactive, new work unrelated
  | 'unauthorized_replacement'  // agent replaced goal without human authority
  | 'depth_escalation'          // subgoal depth exceeded safe threshold
  | 'orphan_subgoal'            // subgoal cannot trace lineage to active goal

export interface DriftLabel {
  session_id: string
  drift: boolean
  drift_type?: DriftType

  /**
   * Unix timestamps, not event sequence indices.
   * Timeline alignment is required for narrative generation and replay.
   */
  drift_started_at?: number
  goal_forgotten_at?: number

  takeover_required: boolean

  annotator_notes?: string

  /**
   * v0: human annotation only.
   * Automated labeling deferred until scoring is validated against human labels.
   */
  annotated_by: 'human'
}

/**
 * A single eval fixture = one real agent session + its ground truth label.
 * The basic unit of the drift detection benchmark.
 */
export interface EvalFixture {
  id: string
  description: string
  agent: AgentType
  session: Session
  label: DriftLabel
  created_at: number
}