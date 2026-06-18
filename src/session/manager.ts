/**
 * SessionManager: orchestrates the full Drift runtime.
 *
 * Wires together:
 *   EventIngestion → GoalStore → DriftScorer → NarrativeEngine → TakeoverEngine
 *
 * This is the primary entry point for agent adapters.
 * An adapter creates a SessionManager, sets the initial goal,
 * then feeds events through processEvent().
 *
 * Usage:
 *   const session = new SessionManager({ agent: 'claude-code' })
 *   session.setGoal('fix login bug')
 *   await session.confirmGoal(session.getActiveGoalId()!, { observable_targets: ['auth'], allowed_domains: ['auth'] })
 *   await session.processEvent({ type: 'tool_call', source: 'agent', payload: { tool_name: 'read_file', target: 'auth.ts' } })
 *   console.log(session.getNarrative())
 */

import type { AgentType } from '../types/session'
import type { GoalScope } from '../types/goal'
import type { DriftScore } from '../types/scoring'
import type { TakeoverRecommendation, TakeoverConfig } from '../governance/takeover'
import type { SessionNarrative } from '../types/narrative'
import type { ScorerConfig, ScorerPersistentState } from '../scoring/scorer'
import type { EmbeddingProvider } from '../embedding/provider'
import { GoalStore } from '../goal/store'
import { EventIngestion, type RawEvent } from '../events/ingestion'
import { DriftScorer } from '../scoring/scorer'
import { NarrativeEngine } from '../narrative/engine'
import { TakeoverEngine } from '../governance/takeover'
import { LangSmithExporter, type LangSmithExporterConfig } from '../exporters/langsmith'
import { ClaimChecker, type ClaimCheckerConfig } from '../verification/claim-checker'
import { SafetyScanner } from '../safety/scanner'
import type { SafetyScannerConfig } from '../safety/types'

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export interface SessionManagerOptions {
  agent:            AgentType
  session_id?:      string
  started_at?:      number   // defaults to Date.now()
  scorer_config?:   Partial<ScorerConfig>
  takeover_config?: Partial<TakeoverConfig>
  embedding?:       EmbeddingProvider
  langsmith?:       boolean | LangSmithExporterConfig
  verification?:    boolean | ClaimCheckerConfig
  safety?:          boolean | Partial<SafetyScannerConfig>
}

export interface ProcessResult {
  drift_score:  DriftScore
  takeover:     TakeoverRecommendation
  new_segments: import('../types/narrative').NarrativeSegment[]
}

export class SessionManager {
  readonly session_id: string
  readonly agent:      AgentType
  readonly started_at: number

  private store:    GoalStore
  private ingestion: EventIngestion
  private scorer:   DriftScorer
  private narrative: NarrativeEngine
  private takeover: TakeoverEngine
  private langsmith: LangSmithExporter | null = null
  private claimChecker: ClaimChecker | null = null
  private safetyScanner: SafetyScanner | null = null

  private lastScore: DriftScore | null = null

  constructor(options: SessionManagerOptions) {
    this.session_id = options.session_id ?? generateId('sess')
    this.agent      = options.agent
    this.started_at = options.started_at ?? Date.now()

    this.store     = new GoalStore(this.session_id)
    this.ingestion = new EventIngestion()
    this.scorer    = new DriftScorer(this.store, options.embedding, options.scorer_config)
    this.narrative = new NarrativeEngine(this.started_at)
    this.takeover  = new TakeoverEngine(this.store, options.takeover_config)

    // LangSmith auto-enables when LANGCHAIN_API_KEY is set, unless explicitly disabled
    const langsmithOpt = options.langsmith
    const explicitlyDisabled = langsmithOpt === false
    if (!explicitlyDisabled) {
      const config = typeof langsmithOpt === 'object' ? langsmithOpt : undefined
      this.langsmith = new LangSmithExporter(config)
    }

    // Verification auto-enables unless explicitly disabled
    const verifyOpt = options.verification
    if (verifyOpt !== false) {
      const config = typeof verifyOpt === 'object' ? verifyOpt : undefined
      this.claimChecker = new ClaimChecker(config)
    }

    // Safety scanner auto-enables unless explicitly disabled
    const safetyOpt = options.safety
    if (safetyOpt !== false) {
      const config = typeof safetyOpt === 'object' ? safetyOpt : undefined
      this.safetyScanner = new SafetyScanner(config)
    }
  }

  // ---------------------------------------------------------------------------
  // Goal management
  // ---------------------------------------------------------------------------

  setGoal(raw: string, created_at?: number): string {
    const goal = this.store.create(raw, created_at)
    return goal.id
  }

  /**
   * Switch the active goal to a new human-issued task, preserving the event
   * timestamp (for replay) instead of using wall-clock now().
   *
   * Real multi-task sessions interleave several user-issued goals ("fix typo",
   * then "now publish the article"). Scoring every later action against the
   * FIRST goal inflates semantic_divergence and produces false positives — the
   * agent didn't drift, the user changed the task. This marks the current
   * active goal as `replaced` (the user authorized the switch) and creates the
   * new goal, so semantic_divergence is computed against the current task, not
   * a stale one.
   *
   * Returns the new goal id. If there is no active goal yet, this is equivalent
   * to setGoal.
   */
  switchGoal(raw: string, created_at?: number): string {
    const current = this.store.getActive()
    if (current) {
      this.store.markReplaced(current.id)
    }
    const goal = this.store.create(raw, created_at)
    return goal.id
  }

  async confirmGoal(goalId: string, normalized: GoalScope): Promise<void> {
    this.store.confirm(goalId, normalized)

    // Emit a goal_confirmed event into the stream
    await this.ingestion.ingest({
      session_id: this.session_id,
      type:       'goal_confirmed',
      source:     'human',
      goal_id:    goalId,
      payload:    { normalized },
    })
  }

  getActiveGoalId(): string | null {
    return this.store.getActive()?.id ?? null
  }

  /**
   * Seed prior tool-call history into the event buffer WITHOUT scoring.
   *
   * Hook deployments are one process per event, so the scorer would otherwise
   * only ever see the single current call — losing the window that signals like
   * consecutive_unrelated, exploratory_entropy and autonomy_momentum depend on.
   * The caller loads persisted history, seeds it here, then calls processEvent
   * for the current tool call. Only that final call is scored (O(N), not O(N²)),
   * but it now scores against the full historical window.
   *
   * Timestamps are preserved so inactive_duration / duration signals stay
   * faithful to when actions actually happened.
   */
  async seedHistory(events: Array<Omit<RawEvent, 'session_id'>>): Promise<void> {
    const activeGoal = this.store.getActive()
    await this.ingestion.ingestBatch(
      events.map(raw => ({
        ...raw,
        session_id: this.session_id,
        goal_id:    raw.goal_id ?? activeGoal?.id,
      })),
    )
  }

  // ---------------------------------------------------------------------------
  // Event processing
  // ---------------------------------------------------------------------------

  /**
   * Process a single agent event through the full pipeline.
   * Returns the drift score, takeover recommendation, and any new narrative segments.
   */
  async processEvent(raw: Omit<RawEvent, 'session_id'>): Promise<ProcessResult> {
    const activeGoal = this.store.getActive()

    const event = await this.ingestion.ingest({
      ...raw,
      session_id: this.session_id,
      goal_id:    raw.goal_id ?? activeGoal?.id,
    })

    // Verify claims in tool_response (hallucination detection)
    if (this.claimChecker) {
      try {
        await this.claimChecker.check(event)
        this.scorer.setHallucinationCount(this.claimChecker.getHallucinationCount())
      } catch {
        // Verification failure should never disrupt the drift runtime
      }
    }

    // Safety scan for dangerous operations
    let safetyRequiresTakeover = false
    if (this.safetyScanner) {
      const scanResult = this.safetyScanner.scan(event)
      safetyRequiresTakeover = scanResult.requires_takeover
    }

    const allEvents  = this.ingestion.getBuffer()
    const score      = await this.scorer.score(allEvents)
    const takeover   = this.takeover.evaluate(this.session_id, score, safetyRequiresTakeover)

    const newSegments = this.narrative.process(event, score, {
      goal:          this.store.getActive(),
      previousScore: this.lastScore ?? undefined,
    })

    this.lastScore = score

    // Export to LangSmith (awaited to ensure session run is registered before finalize)
    if (this.langsmith?.isEnabled()) {
      const goalText = this.store.getActive()?.raw ?? null
      try {
        await this.langsmith.ensureSessionRun(this.session_id, this.agent, goalText)
        await this.langsmith.traceEvent(this.session_id, event, score, takeover)
      } catch {
        // LangSmith export failure should never disrupt the drift runtime
      }
    }

    return { drift_score: score, takeover, new_segments: newSegments }
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  getCurrentScore(): DriftScore | null {
    return this.lastScore
  }

  /**
   * Restore scorer cross-call state (lastAlignedAt + embedding cache) before
   * replaying events. In hook deployments each call is a fresh process, so the
   * caller persists this between invocations to keep inactive_duration accurate
   * and avoid re-embedding the goal on every tool call.
   */
  hydrateScorerState(state: ScorerPersistentState | null | undefined): void {
    this.scorer.hydrateState(state)
  }

  /**
   * Export scorer cross-call state for persistence after processing events.
   */
  dumpScorerState(): ScorerPersistentState {
    return this.scorer.dumpState()
  }

  getNarrative(): SessionNarrative {
    return this.narrative.build(this.session_id)
  }

  getTakeoverStatus(): TakeoverRecommendation | null {
    return this.takeover.getLastRecommendation()
  }

  getGoalStore(): GoalStore {
    return this.store
  }

  getVerificationSummary(): import('../verification/types').VerificationSummary | null {
    return this.claimChecker?.getSummary() ?? null
  }

  getSafetySummary(): import('../safety/types').SafetySummary | null {
    return this.safetyScanner?.getSummary() ?? null
  }

  getSafetyViolations(): import('../safety/types').SafetyViolation[] {
    return this.safetyScanner?.getViolations() ?? []
  }

  /**
   * Finalize the session: closes the LangSmith parent run with final outputs.
   * Call when the session is complete or when you want to flush traces.
   */
  async finalize(): Promise<void> {
    if (!this.langsmith?.isEnabled()) return
    const narrative = this.narrative.build(this.session_id)
    await this.langsmith.finalizeSession(
      this.session_id,
      this.lastScore,
      narrative.overall_summary
    )
  }

  /**
   * Print a live terminal summary — useful for demos.
   *
   * Example:
   *   Session: sess_1234
   *   Goal:    fix login bug [active]
   *   Score:   0.34 (aligned)
   *   Events:  12
   */
  summary(): string {
    const goal  = this.store.getActive()
    const score = this.lastScore
    const events = this.ingestion.getBuffer().length

    return [
      `Session: ${this.session_id}`,
      `Agent:   ${this.agent}`,
      `Goal:    ${goal ? `"${goal.raw}" [${goal.status}]` : '(none)'}`,
      `Score:   ${score ? `${score.score.toFixed(2)} (${score.status})` : 'not yet computed'}`,
      `Events:  ${events}`,
    ].join('\n')
  }
}
