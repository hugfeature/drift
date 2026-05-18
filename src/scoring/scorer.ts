/**
 * DriftScorer: computes DriftScore from event stream + GoalStore state.
 *
 * This is the core algorithm of the Drift project.
 *
 * Scoring combines five independent signals:
 *   1. semantic_divergence   — embedding distance: current actions vs active goal
 *   2. inactive_duration     — how long the active goal has had no aligned actions
 *   3. consecutive_unrelated — run of unrelated events (Goal Forgotten trigger)
 *   4. subgoal_depth         — nesting depth risk
 *   5. exploratory_entropy   — Shannon entropy of recent tool usage
 *   6. unauthorized_mutations — governance violations
 *
 * v0 thresholds (operational, subject to eval-driven tuning):
 *   FORGOTTEN_CONSECUTIVE  = 5  consecutive unrelated actions
 *   FORGOTTEN_INACTIVE_MIN = 10 minutes
 *   DEPTH_RISK_THRESHOLD   = 3  subgoal levels
 *   DRIFTING_SCORE         = 0.5
 *   LOST_SCORE             = 0.75
 *
 * Signal weights sum to 1.0. Adjust via ScorerConfig.
 */

import type { RuntimeEvent, GoalRelation } from '../types/event'
import type { DriftScore, DriftSignals, DriftStatus } from '../types/scoring'
import type { Goal } from '../types/goal'
import { GoalStore } from '../goal/store'
import {
  KeywordEmbeddingProvider,
  type EmbeddingProvider,
  semanticDivergence,
} from '../embedding/provider'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ScorerConfig {
  // Signal weights (must sum to 1.0)
  weights: {
    semantic_divergence:    number   // default 0.35
    inactive_duration:      number   // default 0.20
    consecutive_unrelated:  number   // default 0.20
    subgoal_depth:          number   // default 0.10
    exploratory_entropy:    number   // default 0.10
    unauthorized_mutations: number   // default 0.05
  }
  // Thresholds
  forgotten_consecutive_threshold:  number   // default 5
  forgotten_inactive_minutes:       number   // default 10
  depth_risk_threshold:             number   // default 3
  // Score boundaries
  drifting_score_threshold:         number   // default 0.5
  lost_score_threshold:             number   // default 0.75
  // Rolling window for entropy calculation (event count)
  entropy_window_size:              number   // default 20
}

const DEFAULT_CONFIG: ScorerConfig = {
  weights: {
    semantic_divergence:    0.35,
    inactive_duration:      0.20,
    consecutive_unrelated:  0.20,
    subgoal_depth:          0.10,
    exploratory_entropy:    0.10,
    unauthorized_mutations: 0.05,
  },
  forgotten_consecutive_threshold:  5,
  forgotten_inactive_minutes:       10,
  depth_risk_threshold:             3,
  drifting_score_threshold:         0.5,
  lost_score_threshold:             0.75,
  entropy_window_size:              20,
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export class DriftScorer {
  private config: ScorerConfig
  private embedding: KeywordEmbeddingProvider
  private goalEmbeddings: Map<string, number[]> = new Map()

  // Tracks the last time each goal had an aligned action
  private lastAlignedAt: Map<string, number> = new Map()

  constructor(
    private store: GoalStore,
    embeddingProvider?: EmbeddingProvider,
    config?: Partial<ScorerConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    // KeywordEmbeddingProvider used directly for padToSameLength utility
    this.embedding = (embeddingProvider as KeywordEmbeddingProvider)
      ?? new KeywordEmbeddingProvider()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Compute a drift score from a window of events.
   * Also classifies goal_relation on events that lack it.
   * May trigger GoalStore state transitions (active → drifting → forgotten).
   */
  async score(events: RuntimeEvent[]): Promise<DriftScore> {
    const activeGoal = this.store.getActive()
    const signals    = await this.computeSignals(events, activeGoal)
    const score      = this.weightedScore(signals)
    const status     = this.classifyStatus(score)
    const contributing = this.identifyContributingEvents(events, signals)

    // Side effect: update GoalStore state based on score
    if (activeGoal) {
      await this.applyTransitions(activeGoal, score, signals)
    }

    return {
      score,
      status,
      signals,
      computed_at: Date.now(),
      contributing_event_ids: contributing,
    }
  }

  // ---------------------------------------------------------------------------
  // Signal computation
  // ---------------------------------------------------------------------------

  private async computeSignals(
    events: RuntimeEvent[],
    activeGoal: Goal | null
  ): Promise<DriftSignals> {
    return {
      semantic_divergence:    await this.computeSemanticDivergence(events, activeGoal),
      inactive_duration_minutes: this.computeInactiveDuration(activeGoal),
      consecutive_unrelated:  this.computeConsecutiveUnrelated(events),
      subgoal_depth:          this.computeSubgoalDepthRisk(activeGoal),
      exploratory_entropy:    this.computeExploratoryEntropy(events),
      unauthorized_mutations: this.store.getUnauthorizedMutations().length,
    }
  }

  /**
   * Signal 1: semantic divergence
   * Average embedding distance between recent tool_call events and the active goal.
   */
  private async computeSemanticDivergence(
    events: RuntimeEvent[],
    activeGoal: Goal | null
  ): Promise<number> {
    if (!activeGoal) return 1.0

    const goalText = activeGoal.normalized
      ? activeGoal.normalized.observable_targets.join(' ')
      : activeGoal.raw

    // Cache goal embedding
    if (!this.goalEmbeddings.has(activeGoal.id)) {
      const vec = await this.embedding.embed(goalText)
      this.goalEmbeddings.set(activeGoal.id, vec)
    }
    const goalVec = this.goalEmbeddings.get(activeGoal.id)!

    // Score recent tool_call events
    const recentToolCalls = events
      .filter(e => e.type === 'tool_call')
      .slice(-this.config.entropy_window_size)

    if (recentToolCalls.length === 0) return 0

    const divergences = await Promise.all(
      recentToolCalls.map(async e => {
        const actionText = this.extractActionText(e)
        const actionVec  = await this.embedding.embed(actionText)
        const [padGoal, padAction] = this.embedding.padToSameLength(goalVec, actionVec)
        return semanticDivergence(padGoal, padAction)
      })
    )

    const avg = divergences.reduce((s, d) => s + d, 0) / divergences.length

    // Update goal_relation on events (lazy computation as designed)
    recentToolCalls.forEach((e, i) => {
      if (!e.goal_relation) {
        e.goal_relation = this.classifyRelation(divergences[i])
        e.relation_confidence = 1 - Math.abs(divergences[i] - 0.5) * 2
        e.goal_relation_computed_at = Date.now()

        // Update lastAlignedAt if this event is aligned
        if (e.goal_relation === 'aligned' || e.goal_relation === 'refinement') {
          this.lastAlignedAt.set(activeGoal.id, e.timestamp)
        }
      }
    })

    return Math.min(avg, 1.0)
  }

  /**
   * Signal 2: inactive duration
   * How many minutes since the active goal received an aligned action.
   */
  private computeInactiveDuration(activeGoal: Goal | null): number {
    if (!activeGoal) return 0
    const lastAligned = this.lastAlignedAt.get(activeGoal.id)
    if (!lastAligned) {
      // Never had an aligned action — measure from goal creation
      const minutesSinceCreated = (Date.now() - activeGoal.created_at) / 60_000
      return Math.round(minutesSinceCreated * 10) / 10
    }
    const minutes = (Date.now() - lastAligned) / 60_000
    return Math.round(minutes * 10) / 10
  }

  /**
   * Signal 3: consecutive unrelated events
   * Count the current run of unrelated events from the tail of the stream.
   */
  private computeConsecutiveUnrelated(events: RuntimeEvent[]): number {
    let count = 0
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].goal_relation === 'unrelated') count++
      else break
    }
    return count
  }

  /**
   * Signal 4: subgoal depth risk
   * Normalized: depth / depth_risk_threshold, capped at 1.0
   */
  private computeSubgoalDepthRisk(activeGoal: Goal | null): number {
    if (!activeGoal) return 0
    const depth = activeGoal.subgoal_depth
    return Math.min(depth / this.config.depth_risk_threshold, 1.0)
  }

  /**
   * Signal 5: exploratory entropy
   * Shannon entropy of tool names in the rolling window.
   * High entropy = agent is using many different tools = scattered/exploratory.
   */
  private computeExploratoryEntropy(events: RuntimeEvent[]): number {
    const window = events
      .filter(e => e.type === 'tool_call')
      .slice(-this.config.entropy_window_size)

    if (window.length === 0) return 0

    const freq: Record<string, number> = {}
    for (const e of window) {
      const tool = String(e.payload['tool_name'] ?? 'unknown')
      freq[tool] = (freq[tool] ?? 0) + 1
    }

    const total = window.length
    let entropy = 0
    for (const count of Object.values(freq)) {
      const p = count / total
      entropy -= p * Math.log2(p)
    }

    // Normalize: max entropy for N tools is log2(N)
    const maxEntropy = Math.log2(Object.keys(freq).length || 1)
    return maxEntropy === 0 ? 0 : Math.min(entropy / maxEntropy, 1.0)
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  private weightedScore(signals: DriftSignals): number {
    const w = this.config.weights
    const raw =
      signals.semantic_divergence    * w.semantic_divergence    +
      Math.min(signals.inactive_duration_minutes / this.config.forgotten_inactive_minutes, 1.0)
                                     * w.inactive_duration      +
      Math.min(signals.consecutive_unrelated / this.config.forgotten_consecutive_threshold, 1.0)
                                     * w.consecutive_unrelated  +
      signals.subgoal_depth          * w.subgoal_depth          +
      signals.exploratory_entropy    * w.exploratory_entropy    +
      Math.min(signals.unauthorized_mutations / 3, 1.0)
                                     * w.unauthorized_mutations

    return Math.round(Math.min(raw, 1.0) * 1000) / 1000
  }

  private classifyStatus(score: number): DriftStatus {
    if (score >= this.config.lost_score_threshold)     return 'lost'
    if (score >= this.config.drifting_score_threshold) return 'drifting'
    return 'aligned'
  }

  private classifyRelation(divergence: number): GoalRelation {
    if (divergence < 0.25) return 'aligned'
    if (divergence < 0.45) return 'refinement'
    if (divergence < 0.70) return 'expansion'
    return 'unrelated'
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  private async applyTransitions(
    goal: Goal,
    score: number,
    signals: DriftSignals
  ): Promise<void> {
    const forgottenByConsecutive = signals.consecutive_unrelated >= this.config.forgotten_consecutive_threshold
    const forgottenByInactive    = signals.inactive_duration_minutes >= this.config.forgotten_inactive_minutes

    if (forgottenByConsecutive && forgottenByInactive) {
      if (goal.status === 'active' || goal.status === 'drifting') {
        this.store.markForgotten(goal.id)
        return
      }
    }

    if (score >= this.config.drifting_score_threshold && goal.status === 'active') {
      this.store.markDrifting(goal.id)
      return
    }

    if (score < this.config.drifting_score_threshold && goal.status === 'drifting') {
      this.store.recover(goal.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private extractActionText(event: RuntimeEvent): string {
    const p = event.payload
    const parts = [
      p['tool_name'],
      p['message'],
      p['target'],
      p['tool_input'] ? JSON.stringify(p['tool_input']) : null,
    ].filter(Boolean)
    return parts.join(' ') || 'unknown action'
  }

  private identifyContributingEvents(
    events: RuntimeEvent[],
    signals: DriftSignals
  ): string[] {
    const ids: string[] = []

    // Unrelated run at the tail
    if (signals.consecutive_unrelated > 0) {
      events.slice(-signals.consecutive_unrelated).forEach(e => ids.push(e.id))
    }

    // Unauthorized mutations
    if (signals.unauthorized_mutations > 0) {
      this.store.getUnauthorizedMutations().forEach(m => ids.push(m.id))
    }

    return [...new Set(ids)]
  }
}