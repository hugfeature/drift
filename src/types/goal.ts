/**
 * Goal types for Drift runtime semantics.
 *
 * Core principle: Drift = Goal Alignment Failure
 * A goal is a unit of human intent. Everything else is measured against it.
 */

export type GoalSource = 'human' | 'system' | 'agent'

/**
 * 'completed' is intentionally excluded from v0.
 * Completion detection for autonomous agents is non-trivial:
 *   - agent stopping !== task completed
 *   - human satisfaction is not observable at runtime
 * Deferred to a later version with explicit completion signals.
 */
export type GoalStatus = 'active' | 'drifting' | 'forgotten' | 'replaced'

/**
 * The normalized, operationally observable representation of a human goal.
 *
 * Normalization is a semantic inference problem.
 * v0 strategy: LLM proposes → human confirms via goal_confirmed event.
 *
 * allowed_domains constrains agent scope.
 * Example: goal "fix login bug" → allowed_domains: ["auth", "oauth", "session"]
 * Without this, "upgrade eslint" cannot be classified as refinement vs drift.
 */
export interface GoalScope {
  observable_targets: string[]
  allowed_domains: string[]
  excluded_domains?: string[]
}

export interface Goal {
  id: string
  created_at: number
  source: GoalSource
  raw: string                   // original human input, unmodified
  normalized?: GoalScope        // LLM-inferred, requires human confirmation
  confirmed: boolean            // true after goal_confirmed event
  status: GoalStatus
  subgoal_depth: number         // depth > 3 triggers drift risk

  /**
   * Goal Lineage.
   * v0: flat parent reference only. Graph traversal deferred.
   *
   * Enables orphan subgoal detection:
   * if a subgoal cannot trace back to the active human goal,
   * it is an unauthorized execution branch.
   */
  parent_goal_id?: string
}
