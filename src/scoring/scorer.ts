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
import type { DriftScore, DriftSignals, DriftStatus, BehavioralPathologySignals } from '../types/scoring'
import { RabbitHoleDetector } from './rabbit-hole-detector'
import { ExplanationBuilder } from './explanation-builder'
import type { Goal } from '../types/goal'
import { GoalStore } from '../goal/store'
import {
  KeywordEmbeddingProvider,
  type EmbeddingProvider,
  cosineSimilarity,
  semanticDivergence,
} from '../embedding/provider'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ScorerConfig {
  // Signal weights (must sum to 1.0)
  weights: {
    semantic_divergence:    number   // default 0.22
    inactive_duration:      number   // default 0.13
    consecutive_unrelated:  number   // default 0.13
    subgoal_depth:          number   // default 0.05
    exploratory_entropy:    number   // default 0.10
    unauthorized_mutations: number   // default 0.05
    autonomy_momentum:      number   // default 0.22
    hallucinated_claims:    number   // default 0.10
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
  // Autonomy momentum: tool calls per user interaction threshold
  autonomy_tools_per_prompt_threshold: number // default 30
}

const DEFAULT_CONFIG: ScorerConfig = {
  weights: {
    semantic_divergence:    0.22,
    inactive_duration:      0.13,
    consecutive_unrelated:  0.13,
    subgoal_depth:          0.05,
    exploratory_entropy:    0.10,
    unauthorized_mutations: 0.05,
    autonomy_momentum:      0.22,
    hallucinated_claims:    0.10,
  },
  forgotten_consecutive_threshold:  5,
  forgotten_inactive_minutes:       10,
  depth_risk_threshold:             3,
  drifting_score_threshold:         0.45,
  lost_score_threshold:             0.75,
  entropy_window_size:              20,
  autonomy_tools_per_prompt_threshold: 30,
}

// ---------------------------------------------------------------------------
// System/infrastructure tools that should not affect drift scoring.
// These are agent framework utilities, not goal-directed actions.
// ---------------------------------------------------------------------------

const SYSTEM_TOOL_PATTERNS = [
  /^mcp__/,              // MCP infrastructure tools
  /^TaskCreate$/,        // Task management
  /^TaskUpdate$/,
  /^TaskComplete$/,
  /^Agent$/,             // Sub-agent delegation (framework-level)
]

function isSystemTool(toolName: string): boolean {
  return SYSTEM_TOOL_PATTERNS.some(pattern => pattern.test(toolName))
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export class DriftScorer {
  private config: ScorerConfig
  private embeddingProvider: EmbeddingProvider
  private useRealEmbedding: boolean
  private goalEmbeddingCache: Map<string, number[]> = new Map()
  private rabbitHoleDetector: RabbitHoleDetector

  // Tracks the last time each goal had an aligned action
  private lastAlignedAt: Map<string, number> = new Map()

  // Hallucination count injected by SessionManager from ClaimChecker
  private hallucinationCount = 0

  constructor(
    private store: GoalStore,
    embeddingProvider?: EmbeddingProvider,
    config?: Partial<ScorerConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.embeddingProvider = embeddingProvider ?? new KeywordEmbeddingProvider()
    // Detect if we have a real embedding provider (not keyword-based)
    this.useRealEmbedding = !(this.embeddingProvider instanceof KeywordEmbeddingProvider)
    this.rabbitHoleDetector = new RabbitHoleDetector()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Update hallucination count from external ClaimChecker.
   * Called by SessionManager after each verification pass.
   */
  setHallucinationCount(count: number): void {
    this.hallucinationCount = count
  }

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

    // Behavioral pathology detection (independent of semantic signals)
    const behavioral = this.rabbitHoleDetector.detect(events)

    // Side effect: update GoalStore state based on score
    if (activeGoal) {
      await this.applyTransitions(activeGoal, score, signals)
    }

    const driftScore: DriftScore = {
      score,
      status,
      signals,
      behavioral: behavioral ?? undefined,
      computed_at: Date.now(),
      contributing_event_ids: contributing,
    }

    // Build interpretable explanation trace
    const explanationBuilder = new ExplanationBuilder()
    driftScore.explanation = explanationBuilder.build(driftScore, events)

    return driftScore
  }

  // ---------------------------------------------------------------------------
  // Signal computation
  // ---------------------------------------------------------------------------

  private async computeSignals(
    events: RuntimeEvent[],
    activeGoal: Goal | null
  ): Promise<DriftSignals> {
    // Use latest event timestamp as "now" so replay works correctly.
    // Using Date.now() would break historical session analysis.
    const latestTs = events.length > 0 ? events[events.length - 1].timestamp : Date.now()
    return {
      semantic_divergence:    await this.computeSemanticDivergence(events, activeGoal),
      inactive_duration_minutes: this.computeInactiveDuration(activeGoal, latestTs),
      consecutive_unrelated:  this.computeConsecutiveUnrelated(events),
      subgoal_depth:          this.computeSubgoalDepthRisk(activeGoal),
      exploratory_entropy:    this.computeExploratoryEntropy(events),
      unauthorized_mutations: this.store.getUnauthorizedMutations().length,
      autonomy_momentum:      this.computeAutonomyMomentum(events),
      hallucinated_claims:    this.hallucinationCount,
    }
  }

  /**
   * Signal 1: semantic divergence
   * When using real embedding (nomic/openai): cosine distance between goal and action vectors.
   * When using keyword provider: token-set similarity (legacy fallback).
   */
  private async computeSemanticDivergence(
    events: RuntimeEvent[],
    activeGoal: Goal | null
  ): Promise<number> {
    if (!activeGoal) return 1.0

    // Include allowed_domains in goal text so domain-relevant
    // actions (e.g. auth/login.ts for "fix login bug") score as aligned.
    const goalText = activeGoal.normalized
      ? [
          ...activeGoal.normalized.observable_targets,
          ...activeGoal.normalized.allowed_domains,
        ].join(' ')
      : activeGoal.raw

    // Goal clarity gate: if the goal is too vague/short to meaningfully compare,
    // cap divergence at 0.4 (neutral). Vague goals like "改好了吗", "[Image #1]",
    // timestamps, etc. can never produce meaningful keyword overlap with any action.
    // Assess clarity from raw goal text, not the expanded goalText (which includes
    // allowed_domains tokens that inflate clarity artificially).
    const goalClarity = this.assessGoalClarity(activeGoal.raw)
    const maxDivergence = goalClarity < 0.3 ? 0.4 : 1.0

    // Score recent tool_call events (exclude system/infrastructure tools)
    const recentToolCalls = events
      .filter(e => e.type === 'tool_call' && !isSystemTool(String(e.payload['tool_name'] ?? '')))
      .slice(-this.config.entropy_window_size)

    if (recentToolCalls.length === 0) return 0

    // --- Layer 1: per-event divergence for goal_relation tagging ---
    // Used by consecutive_unrelated signal (needs per-event classification)
    const perEventDivergences = this.useRealEmbedding
      ? await this.computeDivergencesWithEmbedding(goalText, recentToolCalls)
      : this.computeDivergencesWithKeywords(goalText, recentToolCalls)

    // Tag goal_relation on each event.
    // When goal is too vague for meaningful comparison, cap divergence scores
    // so events don't get incorrectly classified as "unrelated".
    recentToolCalls.forEach((e, i) => {
      const effectiveDivergence = Math.min(perEventDivergences[i], maxDivergence)
      e.goal_relation           = this.classifyRelation(effectiveDivergence)
      e.relation_confidence     = goalClarity < 0.3
        ? 0.3  // Low confidence when goal is vague
        : 1 - Math.abs(perEventDivergences[i] - 0.5) * 2
      e.goal_relation_computed_at = Date.now()

      if (e.goal_relation === 'aligned' || e.goal_relation === 'refinement') {
        const current = this.lastAlignedAt.get(activeGoal.id)
        if (!current || e.timestamp > current) {
          this.lastAlignedAt.set(activeGoal.id, e.timestamp)
        }
      }
    })

    // --- Layer 2: session intent summary for final divergence score ---
    // Aggregating actions reveals collective intent that individual events miss.
    // With rich payloads, the summary captures "what was actually done" holistically.
    const summaryDivergence = await this.computeSummaryDivergence(goalText, recentToolCalls)

    // Blend strategy: summary divergence is the primary signal (captures collective
    // runtime intent), per-event avg is secondary (catches individual deviations).
    // Weight summary more heavily — it sees the forest, not just the trees.
    const perEventAvg = perEventDivergences.reduce((s, d) => s + d, 0) / perEventDivergences.length
    const blended = summaryDivergence * 0.6 + perEventAvg * 0.4
    // Apply goal clarity cap — vague goals cannot drive high divergence scores
    return Math.min(blended, maxDivergence)
  }

  /**
   * Compute divergence using aggregated session intent summary.
   * Concatenates recent action payloads into a single text, then compares
   * against goal. This bridges the gap where individual "Read foo.ts" actions
   * have zero keyword overlap with the goal, but collectively the file names,
   * commands, and targets reveal the session's true intent.
   */
  private async computeSummaryDivergence(
    goalText: string,
    events: RuntimeEvent[]
  ): Promise<number> {
    const summary = this.buildRichIntentSummary(events)
    if (this.useRealEmbedding) {
      // Embed the full session summary against goal — captures collective intent
      const goalCacheKey = goalText.slice(0, 300)
      let goalVector = this.goalEmbeddingCache.get(goalCacheKey)
      if (!goalVector) {
        goalVector = await this.embeddingProvider.embed(goalText)
        this.goalEmbeddingCache.set(goalCacheKey, goalVector)
      }
      const summaryVector = await this.embeddingProvider.embed(summary.slice(0, 1000))
      const rawSimilarity = cosineSimilarity(goalVector, summaryVector)
      return this.calibrateEmbeddingDivergence(1 - rawSimilarity)
    }
    const keywordProvider = this.embeddingProvider as KeywordEmbeddingProvider
    const similarity = keywordProvider.tokenSimilarity(goalText, summary)
    return 1 - similarity
  }

  /**
   * Real embedding path: embed goal + each action, compute cosine distance.
   * Goal embedding is cached per goal text to avoid redundant API calls.
   *
   * Applies calibration: raw cosine similarity in code/tool contexts typically
   * falls in [0.2, 0.8] range (even unrelated texts share baseline similarity).
   * We rescale to [0, 1] using empirical bounds so the signal has full dynamic range.
   */
  private async computeDivergencesWithEmbedding(
    goalText: string,
    events: RuntimeEvent[]
  ): Promise<number[]> {
    // Cache goal embedding (same goal text → same vector)
    const goalCacheKey = goalText.slice(0, 300)
    let goalVector = this.goalEmbeddingCache.get(goalCacheKey)
    if (!goalVector) {
      goalVector = await this.embeddingProvider.embed(goalText)
      this.goalEmbeddingCache.set(goalCacheKey, goalVector)
    }

    const divergences: number[] = []
    for (const event of events) {
      // Per-event: use SHORT payload for embedding — calibration bounds are tuned for
      // concise text like "Read scorer.ts", "Edit auth.ts". Rich payloads cause all
      // cosine similarities to collapse into ~0.45-0.55 range, destroying resolution.
      const actionPayload = this.buildExecutionPayload(event)
      const actionVector = await this.embeddingProvider.embed(actionPayload)
      const rawSimilarity = cosineSimilarity(goalVector, actionVector)
      const calibrated = this.calibrateEmbeddingDivergence(1 - rawSimilarity)
      divergences.push(calibrated)
    }
    return divergences
  }

  /**
   * Calibrate raw embedding divergence to full [0, 1] range.
   *
   * Empirical observation: nomic-embed-text cosine similarity for code/tool text:
   *   - Highly aligned (same file/function): similarity ~0.7-0.85 → divergence 0.15-0.30
   *   - Somewhat related (same domain):     similarity ~0.5-0.7  → divergence 0.30-0.50
   *   - Unrelated (different domain):        similarity ~0.2-0.5  → divergence 0.50-0.80
   *
   * Rescale: divergence < 0.25 → 0 (aligned), divergence > 0.65 → 1.0 (unrelated)
   */
  private calibrateEmbeddingDivergence(rawDivergence: number): number {
    const LOW = 0.40   // below this = clearly aligned (calibrated from eval fixtures: 1 - aligned_P75)
    const HIGH = 0.57  // above this = clearly unrelated (calibrated: 1 - unrelated_P25)
    const calibrated = (rawDivergence - LOW) / (HIGH - LOW)
    return Math.max(0, Math.min(1, calibrated))
  }

  /**
   * Keyword fallback path: uses token-set similarity (zero network calls).
   * Uses rich payload so keyword matching has more tokens to work with —
   * file paths, commands, messages all provide signal vs goal text.
   */
  private computeDivergencesWithKeywords(
    goalText: string,
    events: RuntimeEvent[]
  ): number[] {
    const keywordProvider = this.embeddingProvider as KeywordEmbeddingProvider
    return events.map(e => {
      const actionPayload = this.buildRichPayload(e)
      const similarity = keywordProvider.tokenSimilarity(goalText, actionPayload)
      return 1 - similarity
    })
  }

  /**
   * Signal 2: inactive duration
   * How many minutes since the active goal received an aligned action.
   */
  private computeInactiveDuration(activeGoal: Goal | null, asOfTs: number): number {
    if (!activeGoal) return 0
    const lastAligned = this.lastAlignedAt.get(activeGoal.id)
    if (!lastAligned) {
      // Never had an aligned action — measure from goal creation
      const minutesSinceCreated = (asOfTs - activeGoal.created_at) / 60_000
      return Math.round(minutesSinceCreated * 10) / 10
    }
    const minutes = (asOfTs - lastAligned) / 60_000
    return Math.round(minutes * 10) / 10
  }

  /**
   * Signal 3: consecutive unrelated events
   * Count the current run of unrelated events from the tail of the stream.
   * System/infrastructure tools are skipped (not counted, don't break the run).
   */
  private computeConsecutiveUnrelated(events: RuntimeEvent[]): number {
    let count = 0
    for (let i = events.length - 1; i >= 0; i--) {
      const toolName = String(events[i].payload['tool_name'] ?? '')
      if (isSystemTool(toolName)) continue     // skip system tools entirely
      const rel = events[i].goal_relation
      if (rel === undefined) continue          // not yet scored — skip, don't break
      if (rel === 'unrelated') count++
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
   * System/infrastructure tools are excluded.
   */
  private computeExploratoryEntropy(events: RuntimeEvent[]): number {
    const window = events
      .filter(e => e.type === 'tool_call' && !isSystemTool(String(e.payload['tool_name'] ?? '')))
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

  /**
   * Signal 6: autonomy momentum
   * Combines two sub-signals that best separate drift from non-drift:
   *   a) Session duration — drift sessions run much longer (median 237min vs 87min)
   *   b) Tool-to-user ratio — drift sessions have far more tools per user check-in
   *
   * Duration matters because drift is a temporal phenomenon: the agent keeps going
   * without correction for an extended period. Short high-tool-count sessions are
   * usually legitimate batch operations.
   *
   * Suppressed when goal is cron/automation-triggered — these are designed to run
   * autonomously, so high tool-to-user ratio is expected behavior, not drift.
   */
  private computeAutonomyMomentum(events: RuntimeEvent[]): number {
    // Check if active goal is automation/cron triggered — suppress signal entirely
    const activeGoal = this.store.getActive()
    if (activeGoal && this.isAutomationGoal(activeGoal)) return 0

    const toolCalls = events.filter(
      e => e.type === 'tool_call' && !isSystemTool(String(e.payload['tool_name'] ?? ''))
    ).length

    if (toolCalls === 0) return 0

    // Sub-signal a: session duration relative to threshold
    const timestamps = events
      .map(e => e.timestamp)
      .filter(t => t > 0)
    const durationMinutes = timestamps.length >= 2
      ? (Math.max(...timestamps) - Math.min(...timestamps)) / 60_000
      : 0

    // Sessions under 60min are rarely drift; over 200min highly suspicious
    const durationSignal = Math.min(durationMinutes / 200, 1.0)

    // Sub-signal b: tools per user interaction
    const userEvents = events.filter(
      e => e.type === 'goal_created' || e.type === 'goal_confirmed' || e.source === 'human'
    ).length
    const ratio = userEvents > 0 ? toolCalls / userEvents : toolCalls
    const ratioSignal = Math.min(ratio / this.config.autonomy_tools_per_prompt_threshold, 1.0)

    // Combine: duration weighted 60%, ratio 40%
    // Duration is more reliable because it doesn't depend on user event injection
    return durationSignal * 0.6 + ratioSignal * 0.4
  }

  /**
   * Detect if a goal was triggered by automation (cron, scheduler, CI).
   * Automation goals are expected to run autonomously without user interaction.
   */
  private isAutomationGoal(goal: Goal): boolean {
    const raw = goal.raw
    return /^\[cron:/i.test(raw)
      || /^\[schedule:/i.test(raw)
      || /^\[ci:/i.test(raw)
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
                                     * w.unauthorized_mutations +
      signals.autonomy_momentum      * w.autonomy_momentum     +
      Math.min(signals.hallucinated_claims / 3, 1.0)
                                     * w.hallucinated_claims

    return Math.round(Math.min(raw, 1.0) * 1000) / 1000
  }

  private classifyStatus(score: number): DriftStatus {
    if (score >= this.config.lost_score_threshold)     return 'lost'
    if (score >= this.config.drifting_score_threshold) return 'drifting'
    return 'aligned'
  }

  private classifyRelation(divergence: number): GoalRelation {
    if (divergence < 0.35) return 'aligned'
    if (divergence < 0.55) return 'refinement'
    if (divergence < 0.75) return 'expansion'
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

  /**
   * Assess how clear/specific a goal is for semantic comparison.
   * Returns 0-1 where 0 = completely vague, 1 = highly specific.
   *
   * Vague goals (conversational, timestamps, image refs) can never produce
   * meaningful keyword overlap with any action, so divergence should be capped.
   */
  private assessGoalClarity(goalText: string): number {
    const cleaned = goalText
      .replace(/\[.*?\]/g, '')           // Remove [Image #1], [Request...], [timestamps]
      .replace(/\d{4}-\d{2}-\d{2}/g, '') // Remove dates
      .replace(/\d{2}:\d{2}/g, '')       // Remove times
      .replace(/GMT[+-]\d+/g, '')        // Remove timezone
      .replace(/https?:\/\/\S+/g, '')    // Remove URLs (not semantically useful for keyword)
      .trim()

    // Count CJK characters (each one carries semantic meaning, no spaces)
    const cjkChars = (cleaned.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length

    // Count meaningful Latin tokens (>2 chars, not stopwords)
    const stopwords = new Set(['the', 'is', 'at', 'in', 'on', 'for', 'to', 'of', 'and', 'a', 'an'])
    const latinTokens = cleaned
      .split(/[\s,;.!?]+/)
      .filter(t => t.length > 2 && !stopwords.has(t.toLowerCase()) && !/^[\u4e00-\u9fff]+$/.test(t))

    // CJK: ~3 chars ≈ 1 meaningful English token in information density
    const effectiveTokenCount = latinTokens.length + Math.floor(cjkChars / 3)

    // Scoring factors
    const hasActionVerb = /\b(fix|add|create|implement|update|remove|debug|test|verify|build|deploy|refactor|migrate)\b/i.test(cleaned)
      || /[解决修复创建添加删除调试验证部署重构迁移实现更新查看分析检查]/.test(cleaned)
    const hasFilePath = /\.[a-z]{1,4}$/m.test(cleaned) || /\//.test(cleaned)

    // 0-3 tokens = very vague, 4-8 = moderate, 9+ = clear
    let score = Math.min(effectiveTokenCount / 8, 1.0)
    if (hasActionVerb) score = Math.min(score + 0.3, 1.0)
    if (hasFilePath) score = Math.min(score + 0.2, 1.0)

    return score
  }

  /**
   * Build structured execution semantic payload from a runtime event.
   * Output: "{verb} {semantic_target}" — strips noise, preserves intent.
   *
   * Examples: "Read src/scoring/scorer.ts", "Run npm test",
   *           "Fetch blog.google/adk", "Search Google ADK agent"
   */
  private buildExecutionPayload(event: RuntimeEvent): string {
    const p = event.payload
    const toolName = String(p['tool_name'] ?? 'unknown')
    const verb = this.normalizeToolVerb(toolName)
    const target = this.extractSemanticTarget(p)
    return target ? `${verb} ${target}` : verb
  }

  /**
   * Build rich execution payload that preserves full runtime intent.
   * Unlike buildExecutionPayload which abbreviates to "{verb} {target}",
   * this retains command text, file paths, edit descriptions, and tool_input
   * so embedding can capture WHAT the agent is actually doing, not just
   * which tool category it used.
   *
   * Examples:
   *   "Edit src/auth.ts: Fix token refresh logic to handle expired sessions"
   *   "Run npm test -- --grep 'auth' to verify login flow"
   *   "Read package.json to check dependency versions"
   */
  private buildRichPayload(event: RuntimeEvent): string {
    const p = event.payload
    const toolName = String(p['tool_name'] ?? 'unknown')
    const verb = this.normalizeToolVerb(toolName)
    const parts: string[] = [verb]

    // Include full target path (not abbreviated)
    const target = p['target'] as string | undefined
    if (target) parts.push(this.abbreviatePath(target))

    // Include tool_input details (command, file_path, query, content snippet)
    const toolInput = p['tool_input'] as Record<string, unknown> | undefined
    if (toolInput) {
      if (toolInput['file_path']) parts.push(this.abbreviatePath(String(toolInput['file_path'])))
      if (toolInput['command']) parts.push(String(toolInput['command']).slice(0, 200))
      if (toolInput['query']) parts.push(String(toolInput['query']).slice(0, 200))
      if (toolInput['content']) parts.push(String(toolInput['content']).slice(0, 200))
      if (toolInput['description']) parts.push(String(toolInput['description']).slice(0, 200))
      if (toolInput['new_string']) parts.push(`writing: ${String(toolInput['new_string']).slice(0, 150)}`)
    }

    // Include message (often contains intent description)
    const message = String(p['message'] ?? '').trim()
    if (message) parts.push(message.slice(0, 200))

    // Include tool_response snippet if present (reveals what happened)
    const response = String(p['tool_response'] ?? '').trim()
    if (response) parts.push(`result: ${response.slice(0, 100)}`)

    return parts.join(' ').trim().slice(0, 500)
  }

  /**
   * Normalize tool names to semantic verbs.
   * "mcp__engram__recall_memory" → "Recall", "Bash" → "Run"
   */
  private normalizeToolVerb(toolName: string): string {
    const lower = toolName.toLowerCase()
    const stripped = lower.replace(/^mcp__\w+__/, '')
    if (/^(read|view|cat|grep|glob|ls)$/.test(stripped)) return 'Read'
    if (/^(edit|write|save|patch|modify)$/.test(stripped)) return 'Edit'
    if (/^(bash|exec|shell|run|command|terminal)$/.test(stripped)) return 'Run'
    if (/^(web_search|search|query)$/.test(stripped)) return 'Search'
    if (/^(web_fetch|fetch|download|curl)$/.test(stripped)) return 'Fetch'
    if (/^(delete|remove|rm|clean)$/.test(stripped)) return 'Delete'
    if (/^(create|add|new|generate|init|create_task)$/.test(stripped)) return 'Create'
    if (/^(list|enumerate|scan)$/.test(stripped)) return 'List'
    if (/^(recall|remember|recall_memory)$/.test(stripped)) return 'Recall'
    if (/^(cron|schedule)$/.test(stripped)) return 'Schedule'
    return stripped.charAt(0).toUpperCase() + stripped.slice(1)
  }

  /**
   * Extract semantic target from event payload.
   * Priority: file_path > command > query > target > message.
   * Paths and URLs are abbreviated to meaningful segments.
   */
  private extractSemanticTarget(payload: Record<string, unknown>): string {
    const parts: string[] = []

    const toolInput = payload['tool_input'] as Record<string, unknown> | undefined
    if (toolInput) {
      if (toolInput['file_path']) parts.push(this.abbreviatePath(String(toolInput['file_path'])))
      if (toolInput['command']) parts.push(String(toolInput['command']).slice(0, 120))
      if (toolInput['query']) parts.push(String(toolInput['query']).slice(0, 120))
      if (toolInput['description']) parts.push(String(toolInput['description']).slice(0, 120))
    }

    if (payload['target']) parts.push(this.abbreviatePath(String(payload['target'])))

    const message = String(payload['message'] ?? '').trim()
    if (message) {
      const urlPattern = /https?:\/\/[^\s)]+/g
      const withAbbreviatedUrls = message.replace(urlPattern, url => this.abbreviatePath(url))
      parts.push(withAbbreviatedUrls.slice(0, 150))
    }

    return parts.join(' ').trim()
  }

  /**
   * Abbreviate file paths and URLs to semantically meaningful parts.
   * "/Users/x/project/src/scoring/scorer.ts" → "src/scoring/scorer.ts"
   * "https://blog.google/.../google-adk/" → "blog.google/google-adk"
   */
  private abbreviatePath(fullPath: string): string {
    if (fullPath.startsWith('http://') || fullPath.startsWith('https://')) {
      try {
        const url = new URL(fullPath)
        const pathSegments = url.pathname.split('/').filter(Boolean)
        const lastSegment = pathSegments.slice(-1)[0] ?? ''
        return `${url.hostname}/${lastSegment}`
      } catch {
        return fullPath.slice(0, 80)
      }
    }

    const segments = fullPath.split(/[/\\]/).filter(Boolean)
    const homeIdx = segments.findIndex(s => s === 'Users' || s === 'home')
    const meaningful = homeIdx >= 0 ? segments.slice(homeIdx + 2) : segments
    return meaningful.slice(-3).join('/')
  }

  /**
   * Aggregate recent action payloads into a session intent summary.
   * More tokens = more keyword overlap opportunities with the goal.
   */
  private buildSessionIntentSummary(events: RuntimeEvent[]): string {
    return events.map(e => this.buildExecutionPayload(e)).join('; ')
  }

  /**
   * Build rich intent summary using full execution payloads.
   * Captures what the agent actually did across the window — commands run,
   * files touched, edits made — so embedding can see collective intent.
   */
  private buildRichIntentSummary(events: RuntimeEvent[]): string {
    return events.map(e => this.buildRichPayload(e)).join('; ')
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