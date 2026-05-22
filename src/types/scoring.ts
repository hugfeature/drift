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

  /**
   * Ratio of tool_call events to total events in the session window.
   * High autonomy (close to 1.0) = agent running without user direction.
   * Normalized: tool_calls / (tool_calls + user_events).
   * This is the strongest structural signal for drift detection.
   */
  autonomy_momentum: number

  /**
   * Count of hallucinated claims detected by the verification system.
   * A hallucination = agent claimed something happened that didn't
   * (e.g. "file written" but file doesn't exist).
   * 0 = all claims verified or no claims made.
   */
  hallucinated_claims: number
}

/**
 * Behavioral pathology signals for rabbit_hole detection.
 *
 * Rabbit hole is NOT "divergence from goal" — it's "infinite recursion within goal".
 * The agent keeps working on the right thing but never converges:
 *   - Repeatedly reading/editing the same files
 *   - Running the same commands hoping for different results
 *   - Novelty of actions decays over time (fewer new targets)
 *   - No measurable progress despite high activity
 *
 * These signals are independent of semantic_divergence and operate on
 * behavioral patterns rather than goal-action similarity.
 */
export interface BehavioralPathologySignals {
  /**
   * Target repetition ratio in recent window.
   * High value = agent keeps touching the same files/commands.
   * 0.0 = all unique targets, 1.0 = same target every time.
   */
  target_repetition: number

  /**
   * Rate at which new targets appear in the event stream.
   * Measures novelty decay: early in a session, most actions hit new targets;
   * in a rabbit hole, the stream becomes increasingly repetitive.
   * 0.0 = no new targets appearing, 1.0 = every action hits a new target.
   */
  novelty_rate: number

  /**
   * Progress stagnation: ratio of Read/Bash (exploration) to Edit (progress).
   * In a healthy session, exploration leads to edits. In a rabbit hole,
   * the agent keeps reading/running but produces fewer edits over time.
   * 0.0 = balanced or edit-heavy, 1.0 = pure exploration with no edits.
   */
  progress_stagnation: number

  /**
   * Composite rabbit_hole score combining all behavioral signals.
   * 0.0 = healthy behavior, 1.0 = definite rabbit hole.
   */
  rabbit_hole_score: number
}

/**
 * Severity classification for drift explanations.
 * Maps to actionability: low = informational, critical = requires immediate intervention.
 */
export type DriftSeverity = 'low' | 'moderate' | 'high' | 'critical'

/**
 * A single piece of evidence supporting a drift diagnosis.
 * Each evidence item is self-contained and human-readable.
 */
export interface DriftEvidence {
  /** What signal produced this evidence */
  signal: keyof DriftSignals | keyof BehavioralPathologySignals | 'composite'
  /** Human-readable description of what was observed */
  observation: string
  /** Quantitative value backing the observation */
  value: number
  /** Optional: specific event IDs or targets involved */
  details?: string[]
}

/**
 * Structured diagnostic trace for a drift detection.
 * Transforms raw scores into an interpretable narrative.
 *
 * This is the "inference narration layer" — it answers:
 *   - WHAT type of drift was detected?
 *   - WHY was it classified this way? (evidence chain)
 *   - HOW severe is it?
 *   - WHEN did it start?
 */
export interface DriftExplanation {
  /** Primary drift classification */
  classification: 'aligned' | 'rabbit_hole' | 'scope_expansion' | 'goal_forgotten' | 'autonomy_runaway' | 'mixed'
  /** Severity assessment */
  severity: DriftSeverity
  /** One-line summary for humans */
  summary: string
  /** Ordered evidence chain (most important first) */
  evidence: DriftEvidence[]
  /** Event index where pathology first became detectable */
  first_observed_at?: number
  /** Recommended action */
  recommendation?: string
}

export interface DriftScore {
  score: number                       // 0.0 - 1.0
  status: DriftStatus
  signals: DriftSignals
  behavioral?: BehavioralPathologySignals
  explanation?: DriftExplanation
  computed_at: number
  contributing_event_ids: string[]    // events that drove this score
}