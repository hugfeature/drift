/**
 * TakeoverEngine: determines when human intervention is warranted.
 *
 * This is the runtime governance layer.
 * It upgrades drift detection from "observability" to "actionable oversight".
 *
 * The engine emits TakeoverRecommendation objects, not just scores.
 * Each recommendation includes:
 *   - why intervention is suggested
 *   - what specifically triggered it
 *   - what the human should check
 *
 * Trigger conditions (any one is sufficient):
 *   SCORE_CRITICAL     drift score >= 0.75
 *   GOAL_FORGOTTEN     GoalStore reports forgotten goal
 *   DEPTH_CRITICAL     subgoal depth > depth_risk_threshold
 *   UNAUTHORIZED_MUT   any unauthorized mutation detected
 *   ENTROPY_SPIKE      exploratory entropy > 0.9 for 3+ consecutive scores
 */

import type { DriftScore } from '../types/scoring'
import type { Goal } from '../types/goal'
import { GoalStore } from '../goal/store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TakeoverTrigger =
  | 'score_critical'
  | 'goal_forgotten'
  | 'depth_critical'
  | 'unauthorized_mutation'
  | 'entropy_spike'

export interface TakeoverRecommendation {
  session_id:        string
  timestamp:         number
  recommended:       boolean
  triggers:          TakeoverTrigger[]
  drift_score:       number
  active_goal:       string | null     // goal raw text, for readability
  reasons:           string[]          // human-readable explanation
  suggested_actions: string[]          // what the human should do
}

export interface TakeoverConfig {
  score_critical_threshold:   number   // default 0.75
  depth_critical_threshold:   number   // default 3
  entropy_spike_threshold:    number   // default 0.9
  entropy_spike_consecutive:  number   // default 3
}

const DEFAULT_TAKEOVER_CONFIG: TakeoverConfig = {
  score_critical_threshold:  0.75,
  depth_critical_threshold:  3,
  entropy_spike_threshold:   0.9,
  entropy_spike_consecutive: 3,
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TakeoverEngine {
  private config: TakeoverConfig
  private recentEntropyScores: number[] = []
  private lastRecommendation: TakeoverRecommendation | null = null

  constructor(
    private store: GoalStore,
    config?: Partial<TakeoverConfig>
  ) {
    this.config = { ...DEFAULT_TAKEOVER_CONFIG, ...config }
  }

  /**
   * Evaluate current state and return a TakeoverRecommendation.
   * Called after every DriftScore is computed.
   */
  evaluate(session_id: string, score: DriftScore): TakeoverRecommendation {
    const activeGoal = this.store.getActive()
    const triggers: TakeoverTrigger[] = []
    const reasons: string[] = []
    const actions: string[] = []

    // Track entropy history for spike detection
    this.recentEntropyScores.push(score.signals.exploratory_entropy)
    if (this.recentEntropyScores.length > this.config.entropy_spike_consecutive * 2) {
      this.recentEntropyScores.shift()
    }

    // --- Trigger: score critical ---
    if (score.score >= this.config.score_critical_threshold) {
      triggers.push('score_critical')
      reasons.push(`Drift score ${score.score.toFixed(2)} exceeds critical threshold`)
      actions.push('Review recent agent actions and verify alignment with original goal')
    }

    // --- Trigger: goal forgotten ---
    if (activeGoal && activeGoal.status === 'forgotten') {
      triggers.push('goal_forgotten')
      reasons.push(
        `Original goal "${activeGoal.raw}" has been inactive for ` +
        `${Math.round(score.signals.inactive_duration_minutes)} minutes`
      )
      actions.push(`Re-state the original goal or explicitly replace it`)
    }

    // --- Trigger: depth critical ---
    const rawDepth = activeGoal?.subgoal_depth ?? 0
    if (rawDepth > this.config.depth_critical_threshold) {
      triggers.push('depth_critical')
      reasons.push(`Subgoal nesting depth ${rawDepth} exceeds safe threshold of ${this.config.depth_critical_threshold}`)
      actions.push('Check whether the agent is still on task or has recursively expanded scope')
    }

    // --- Trigger: unauthorized mutation ---
    const unauthorizedCount = this.store.getUnauthorizedMutations().length
    if (unauthorizedCount > 0) {
      triggers.push('unauthorized_mutation')
      reasons.push(`${unauthorizedCount} unauthorized goal mutation(s) detected`)
      actions.push('Review and explicitly approve or reject the agent\'s proposed goal changes')
    }

    // --- Trigger: entropy spike ---
    const recentWindow = this.recentEntropyScores.slice(-this.config.entropy_spike_consecutive)
    const isEntropySpike =
      recentWindow.length >= this.config.entropy_spike_consecutive &&
      recentWindow.every(e => e >= this.config.entropy_spike_threshold)

    if (isEntropySpike) {
      triggers.push('entropy_spike')
      reasons.push(`Tool usage entropy has been critically high for ${this.config.entropy_spike_consecutive}+ consecutive evaluations`)
      actions.push('Agent appears to be exploring broadly — verify it has not lost focus')
    }

    const recommended = triggers.length > 0

    const recommendation: TakeoverRecommendation = {
      session_id,
      timestamp:         Date.now(),
      recommended,
      triggers,
      drift_score:       score.score,
      active_goal:       activeGoal?.raw ?? null,
      reasons,
      suggested_actions: actions,
    }

    if (recommended) {
      this.lastRecommendation = recommendation
    }

    return recommendation
  }

  getLastRecommendation(): TakeoverRecommendation | null {
    return this.lastRecommendation
  }

  /**
   * Formatted text output — ready to print to terminal or send to UI.
   *
   * Example:
   *   ⚠️  Human Takeover Recommended
   *   Drift Score: 0.82
   *   Active Goal: fix login bug
   *
   *   Reasons:
   *   - Drift score 0.82 exceeds critical threshold
   *   - Original goal inactive for 12 minutes
   *
   *   Suggested Actions:
   *   - Review recent agent actions and verify alignment with original goal
   *   - Re-state the original goal or explicitly replace it
   */
  format(rec: TakeoverRecommendation): string {
    if (!rec.recommended) {
      return `✓  Agent aligned  (drift score: ${rec.drift_score.toFixed(2)})`
    }

    const lines: string[] = [
      `⚠️  Human Takeover Recommended`,
      `Drift Score: ${rec.drift_score.toFixed(2)}`,
      `Active Goal: ${rec.active_goal ?? '(none)'}`,
      ``,
      `Reasons:`,
      ...rec.reasons.map(r => `  - ${r}`),
      ``,
      `Suggested Actions:`,
      ...rec.suggested_actions.map(a => `  - ${a}`),
    ]

    return lines.join('\n')
  }
}