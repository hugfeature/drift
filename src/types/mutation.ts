/**
 * GoalMutation types for Drift runtime governance.
 *
 * Key insight: drift is often not an event anomaly.
 * It is an unauthorized mutation of the active goal.
 *
 * GoalMutation is the core object of runtime governance,
 * not just a subtype of RuntimeEvent.
 */

import type { GoalSource } from './goal'

export type MutationType = 'refine' | 'expand' | 'replace' | 'cancel'

export interface GoalMutation {
  id: string
  session_id: string
  from_goal_id: string
  to_goal_id?: string           // undefined for cancel mutations

  source: GoalSource
  mutation_type: MutationType

  /**
   * Authorization is determined by the mutation rules table at creation time.
   * It is computed by the system, not set by the initiating actor.
   *
   * Mutation rules (from goal-model-v0):
   *   Human:  create ✓  refine ✓  expand ✓  replace ✓
   *   System: create ✗  refine ✓  expand suggest-only  replace ✗
   *   Agent:  create ✗  refine ✓ (within scope)  expand suggest-only  replace ✗
   *
   * Unauthorized mutations are the primary governance event.
   */
  authorized: boolean

  reason?: string
  timestamp: number
}