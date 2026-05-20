/**
 * LangSmith Exporter: streams Drift runtime events to LangSmith.
 *
 * Architecture:
 *   SessionManager.processEvent()
 *       → DriftScorer.score()
 *       → LangSmithExporter.traceEvent()   ← this module
 *       → LangSmith Dashboard (external)
 *
 * Each Drift session maps to a LangSmith parent run (type: "chain").
 * Each processEvent call maps to a child run (type: "tool").
 * Drift scores, signals, and takeover recommendations are attached as outputs.
 *
 * The exporter is opt-in: only active when LANGCHAIN_API_KEY is set
 * and the SessionManager is constructed with { langsmith: true }.
 */

import { Client } from 'langsmith'
import type { RuntimeEvent } from '../types/event'
import type { DriftScore } from '../types/scoring'
import type { TakeoverRecommendation } from '../governance/takeover'

export interface LangSmithExporterConfig {
  projectName?: string
  enabled?: boolean
}

export class LangSmithExporter {
  private client: Client | null = null
  private projectName: string
  private enabled: boolean
  private sessionRunIds: Map<string, string> = new Map()

  constructor(config?: LangSmithExporterConfig) {
    this.projectName = config?.projectName
      ?? process.env.LANGCHAIN_PROJECT
      ?? 'drift-dev'

    const hasApiKey = Boolean(process.env.LANGCHAIN_API_KEY)
    this.enabled = (config?.enabled ?? true) && hasApiKey

    if (this.enabled) {
      this.client = new Client()
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Create or retrieve the parent run for a drift session.
   * Called once per session on first event.
   */
  async ensureSessionRun(
    sessionId: string,
    agent: string,
    goalText: string | null
  ): Promise<string> {
    if (!this.client) return ''

    const existing = this.sessionRunIds.get(sessionId)
    if (existing) return existing

    const runId = crypto.randomUUID()
    await this.client.createRun({
      id: runId,
      name: `drift-session-${sessionId.slice(0, 12)}`,
      run_type: 'chain',
      project_name: this.projectName,
      inputs: {
        session_id: sessionId,
        agent,
        goal: goalText ?? '(no goal set)',
        started_at: new Date().toISOString(),
      },
    })

    this.sessionRunIds.set(sessionId, runId)
    return runId
  }

  /**
   * Trace a single processed event with its drift score.
   * Creates a child run under the session parent.
   */
  async traceEvent(
    sessionId: string,
    event: RuntimeEvent,
    score: DriftScore,
    takeover: TakeoverRecommendation
  ): Promise<void> {
    if (!this.client) return

    const parentRunId = this.sessionRunIds.get(sessionId)
    if (!parentRunId) return

    const toolName = String(event.payload['tool_name'] ?? event.type)
    const target = event.payload['target'] ?? event.payload['message'] ?? ''

    const childRunId = crypto.randomUUID()
    await this.client.createRun({
      id: childRunId,
      name: `${toolName}${target ? ` → ${String(target).slice(0, 40)}` : ''}`,
      run_type: 'tool',
      project_name: this.projectName,
      parent_run_id: parentRunId,
      inputs: {
        event_id: event.id,
        event_type: event.type,
        tool_name: toolName,
        target: String(target),
        goal_relation: event.goal_relation ?? 'pending',
        timestamp: new Date(event.timestamp).toISOString(),
      },
    })

    await this.client.updateRun(childRunId, {
      outputs: {
        drift_score: score.score,
        drift_status: score.status,
        signals: {
          semantic_divergence: score.signals.semantic_divergence,
          inactive_minutes: score.signals.inactive_duration_minutes,
          consecutive_unrelated: score.signals.consecutive_unrelated,
          autonomy_momentum: score.signals.autonomy_momentum,
          exploratory_entropy: score.signals.exploratory_entropy,
        },
        takeover_recommended: takeover.recommended,
        takeover_triggers: takeover.triggers,
      },
      end_time: Date.now(),
    })
  }

  /**
   * Finalize the session run with final score and narrative.
   * Called when the session ends or on explicit flush.
   */
  async finalizeSession(
    sessionId: string,
    finalScore: DriftScore | null,
    narrative: string
  ): Promise<void> {
    if (!this.client) return

    const runId = this.sessionRunIds.get(sessionId)
    if (!runId) return

    await this.client.updateRun(runId, {
      outputs: {
        final_drift_score: finalScore?.score ?? 0,
        final_status: finalScore?.status ?? 'unknown',
        narrative,
        completed_at: new Date().toISOString(),
      },
      end_time: Date.now(),
    })
  }
}
