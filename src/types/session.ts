/**
 * Session types for Drift.
 *
 * Core insight: drift is not a property of a single goal.
 * It is the emergent state of a runtime session evolving over time.
 *
 * Session is the primary unit of analysis, not Goal.
 * Goal is a component of Session.
 */

import type { Goal } from './goal'
import type { DriftScore } from './scoring'

export type AgentType =
  | 'claude-code'
  | 'cursor'
  | 'openai-agent'
  | 'cline'
  | 'unknown'

export interface Session {
  id: string
  started_at: number
  ended_at?: number
  agent: AgentType

  /**
   * Ordered by created_at ascending.
   * Multiple goals may exist per session due to replacements or expansions.
   * Goal lineage is tracked via Goal.parent_goal_id.
   */
  goals: Goal[]
  active_goal_id: string | null

  /**
   * Session-level drift score.
   * Aggregated from all events and goal transitions in this session.
   * Updated incrementally as new events arrive.
   */
  drift_score?: DriftScore
}