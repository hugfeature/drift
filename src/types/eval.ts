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
import type { FailureAnnotation } from './failure'

export type DriftType =
  | 'scope_expansion'           // agent expanded beyond allowed_domains (subsumes depth_escalation as evidence)
  | 'goal_forgotten'            // original goal inactive, new work unrelated (subtypes: context_decay, interruption_induced, autonomous_shift)
  | 'unauthorized_replacement'  // agent replaced goal without human authority
  | 'orphan_subgoal'            // subgoal cannot trace lineage to active goal
  | 'conflicting_context'       // contradictory information in context causes agent confusion
  | 'premature_completion'      // agent claimed "done" without verification — claimed_done != actually_done
  | 'unauthorized_mutation'     // agent performed writes on a read-only/status-check task
  | 'rabbit_hole'               // agent over-iterated on one approach far beyond task requirements
  | 'cleanup_spiral'            // agent entered self-sustaining execution loop without stopping condition
  | 'constraint_relaxation'     // agent unilaterally relaxed explicit user/environment constraints (lowered the bar, openly)
  | 'constraint_circumvention'  // agent adversarially evaded a still-in-force guardrail (obfuscation, aliasing, rerouting) — constraint not relaxed, just bypassed
  | 'goal_narrowing'            // agent silently delivered less than requested
  | 'incomplete_followthrough'  // agent left dangling state (unclosed tasks, partial configs)

/**
 * Groundtruth quality classification.
 * Fixtures with weak goals (unknown, image-only, ambiguous short text)
 * cannot be reliably evaluated — they should be excluded from precision/recall
 * or reported separately.
 */
export type GroundtruthQuality = 'strong' | 'weak'

/**
 * Reason why a fixture is classified as weak-groundtruth.
 */
export type WeakReason =
  | 'unknown_goal'        // goal text is "unknown goal" or empty
  | 'image_reference'     // goal references an image that the system cannot see
  | 'interrupted'         // session was interrupted, no clear task intent
  | 'ambiguous_short'     // goal text too short/vague to determine intent

export interface DriftLabel {
  session_id: string
  drift: boolean
  drift_type?: DriftType

  /**
   * Tri-state observability flag.
   * Some sessions are not clearly drift or aligned — they exhibit behavior
   * that is "worth inspection" but not definitively wrong.
   *
   * - true:  behavior is ambiguous/exploratory but notable (e.g. legitimate exploration
   *          that resembles scope_expansion, or boundary-crossing that may be valid)
   * - false/undefined: standard binary label applies
   *
   * Fixtures with worth_inspection=true are excluded from Precision/Recall
   * calculation but included in explainability evaluation (trace quality,
   * classification stability, diagnostic usefulness).
   */
  worth_inspection?: boolean

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

  /**
   * Groundtruth quality. Weak fixtures have ambiguous/missing goals
   * that make drift detection evaluation unreliable.
   * Defaults to 'strong' if not set.
   */
  groundtruth_quality?: GroundtruthQuality
  weak_reason?: WeakReason
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

  /**
   * Three-layer failure chain annotation.
   * Optional: only present on fixtures that have been annotated with
   * the propagation-chain failure taxonomy.
   * See src/types/failure.ts for schema details.
   */
  failure_annotation?: FailureAnnotation
}