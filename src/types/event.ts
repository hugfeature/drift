/**
 * RuntimeEvent types for Drift event stream.
 *
 * Core insight: drift is not the event itself.
 * It is the relationship between an event and the current active goal.
 *
 * goal_relation is the semantic join between execution and intent.
 */

import type { GoalSource } from './goal'

export type EventType =
  | 'goal_created'
  | 'goal_confirmed'
  | 'goal_mutated'
  | 'tool_call'
  | 'subgoal_created'
  | 'drift_detected'
  | 'takeover_recommended'

export type GoalRelation =
  | 'aligned'       // action serves the current goal
  | 'refinement'    // action narrows scope, still within goal
  | 'expansion'     // action broadens scope beyond goal
  | 'unrelated'     // action has no traceable connection to goal

export interface RuntimeEvent {
  id: string
  timestamp: number
  session_id: string
  type: EventType
  source: GoalSource
  payload: Record<string, unknown>

  goal_id?: string              // which goal this event relates to

  /**
   * goal_relation is lazy-computed by the drift scorer.
   * It is NOT populated at event ingestion time.
   *
   * Reason: computing relation requires embedding comparison,
   * which would block the ingestion pipeline.
   *
   * relation_confidence captures the probabilistic nature of alignment:
   * 'aligned' and 'unrelated' are often clear.
   * 'refinement' vs 'expansion' boundary is frequently ambiguous.
   */
  goal_relation?: GoalRelation
  relation_confidence?: number  // 0.0 - 1.0
  goal_relation_computed_at?: number
}