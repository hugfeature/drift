/**
 * Scoring types for Drift detection.
 *
 * DriftScore combines multiple signals.
 * No single signal is sufficient for drift classification.
 *
 * v0 heuristic thresholds (operational, not theoretically optimal):
 *   - 5 consecutive unrelated actions → Goal Forgotten candidate
 *   - 10 minute inactive goal window → Goal Forgotten candidate
 *   - subgoal_depth > 3 → elevated risk
 *
 * Thresholds evolve through eval benchmarking.
 */

export type DriftStatus = 'aligned' | 'drifting' | 'lost'

export interface DriftSignals {
  /**
   * Embedding distance between recent actions and active goal.
   * 0.0 = fully aligned, 1.0 = completely unrelated.
   */
  semantic_divergence: number

  /**
   * How long the active goal has received no aligned actions.
   * Paired with consecutive_unrelated for Goal Forgotten detection.
   */
  inactive_duration_minutes: number

  /**
   * Number of consecutive events classified as 'unrelated'.
   * v0 threshold: 5
   */
  consecutive_unrelated: number

  /**
   * Current depth of agent subgoal nesting.
   * v0 threshold: 3
   */
  subgoal_depth: number

  /**
   * Shannon entropy of tool usage in recent window.
   * High entropy = increasingly scattered, exploratory behavior.
   */
  exploratory_entropy: number

  /**
   * Count of unauthorized mutations in this session.
   * Each unauthorized GoalMutation increments this.
   */
  unauthorized_mutations: number
}

export interface DriftScore {
  score: number                       // 0.0 - 1.0
  status: DriftStatus
  signals: DriftSignals
  computed_at: number
  contributing_event_ids: string[]    // events that drove this score
}