/**
 * CandidateCollector — automatically collects high/low confidence sessions
 * as eval fixture candidates.
 *
 * Strategy:
 *   - High confidence drift (score >= 0.7): auto-label as drift candidate
 *   - High confidence aligned (score <= 0.15): auto-label as no-drift candidate
 *   - Middle range is ignored (not enough signal for auto-labeling)
 *
 * Output: JSON fixture in eval/candidates/ ready for human review.
 * Human reviews with `scripts/review-candidates.ts` to approve/reject into eval set.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface CandidateSession {
  session_id: string
  started_at: number
  agent: string
  goal: string
  events: CandidateEvent[]
  final_score: number
  final_status: string
  event_count: number
  /**
   * Composite risk score (v0.1 execution fused with v0.2 cognitive hits via
   * layered-max). When present, collection is gated on this instead of the raw
   * v0.1 final_score, so a session a cognitive signal flagged (but whose v0.1
   * score stayed low) is still captured. Optional for callers that only have
   * the v0.1 score.
   */
  composite_score?: number
  /** Names of the zero-FP cognitive signals that fired, if any. */
  cognitive_signals?: string[]
}

export interface CandidateEvent {
  event_index: number
  timestamp: number
  event_type: string
  tool_name?: string
  tool_input?: unknown
  tool_result?: unknown
  message?: string
  goal?: string
  drift_score?: number
  status?: string
}

export interface CandidateFixture {
  id: string
  description: string
  agent: string
  created_at: number
  source: 'auto_collected'
  auto_label: {
    drift: boolean
    confidence: 'high' | 'medium'
    final_score: number
    /** Composite score used for the gate, when available (else mirrors final_score). */
    composite_score?: number
    /** Cognitive signals that fired, when the composite was driven by the cognitive layer. */
    cognitive_signals?: string[]
    reason: string
  }
  session: {
    id: string
    started_at: number
    agent: string
    active_goal_id: string
    goals: Array<{
      id: string
      created_at: number
      source: 'human'
      raw: string
      confirmed: boolean
      status: string
      subgoal_depth: number
    }>
    events: Array<{
      id: string
      timestamp: number
      session_id: string
      type: string
      source: string
      goal_id: string
      payload: Record<string, unknown>
    }>
  }
  needs_review: true
}

export interface CollectorConfig {
  /** Score threshold above which session is auto-labeled as drift */
  driftThreshold: number
  /** Score threshold below which session is auto-labeled as aligned */
  alignedThreshold: number
  /** Minimum events required to be considered a valid candidate */
  minimumEvents: number
  /** Maximum candidates to keep (FIFO rotation) */
  maxCandidates: number
  /** Output directory for candidates */
  outputDir: string
}

const DEFAULT_CONFIG: CollectorConfig = {
  driftThreshold: 0.70,
  alignedThreshold: 0.15,
  minimumEvents: 8,
  maxCandidates: 50,
  outputDir: path.resolve(__dirname, '../../eval/candidates'),
}

export class CandidateCollector {
  private config: CollectorConfig

  constructor(config?: Partial<CollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Evaluate whether a completed session qualifies as a candidate fixture.
   * Returns the path of the written fixture, or null if session was skipped.
   */
  collect(session: CandidateSession): string | null {
    // Gate: minimum event count
    if (session.event_count < this.config.minimumEvents) return null

    // Gate: must have a meaningful goal (not error messages or system artifacts)
    if (!session.goal || session.goal.trim().length < 3) return null
    if (this.isInvalidGoal(session.goal)) return null

    // Gate on the composite when available — this lets a session a cognitive
    // signal flagged (composite lifted to the cognitive floor) be captured even
    // if its raw v0.1 final_score stayed below the drift threshold. Falls back
    // to the v0.1 score for callers that don't compute a composite.
    const gateScore = session.composite_score ?? session.final_score
    const isDriftCandidate = gateScore >= this.config.driftThreshold
    const isAlignedCandidate = gateScore <= this.config.alignedThreshold

    if (!isDriftCandidate && !isAlignedCandidate) return null

    // Build fixture
    const fixture = this.buildFixture(session, isDriftCandidate)

    // Ensure output directory exists
    fs.mkdirSync(this.config.outputDir, { recursive: true })

    // Rotate if at capacity
    this.rotateIfNeeded()

    // Write fixture
    const filename = `candidate_${fixture.id}.json`
    const outputPath = path.join(this.config.outputDir, filename)
    fs.writeFileSync(outputPath, JSON.stringify(fixture, null, 2))

    return outputPath
  }

  private buildFixture(session: CandidateSession, isDrift: boolean): CandidateFixture {
    const timestamp = Date.now()
    const fixtureId = `auto_${timestamp.toString(36)}_${Math.random().toString(36).slice(2, 6)}`

    const goalId = `goal_${session.session_id.slice(-6)}`

    // Convert raw events to fixture format
    const fixtureEvents = session.events
      .filter(e => e.event_type === 'tool_call' || e.event_type === 'goal_set')
      .map((e, index) => ({
        id: `evt_${String(index + 1).padStart(3, '0')}`,
        timestamp: e.timestamp,
        session_id: session.session_id,
        type: e.event_type === 'goal_set' ? 'goal_created' : 'tool_call',
        source: e.event_type === 'goal_set' ? 'human' as const : 'agent' as const,
        goal_id: goalId,
        payload: e.event_type === 'tool_call'
          ? {
              tool_name: e.tool_name ?? 'unknown',
              target: this.extractTarget(e),
              message: e.message,
            }
          : { raw: e.goal ?? session.goal },
      }))

    const gateScore = session.composite_score ?? session.final_score
    const cognitiveDriven = (session.cognitive_signals?.length ?? 0) > 0
    const scoreLabel = session.composite_score !== undefined
      ? `composite ${gateScore.toFixed(3)} (v0.1 ${session.final_score.toFixed(3)})`
      : `score ${session.final_score.toFixed(3)}`

    let reason = isDrift
      ? `${scoreLabel} >= ${this.config.driftThreshold} (auto-drift)`
      : `${scoreLabel} <= ${this.config.alignedThreshold} (auto-aligned)`
    if (cognitiveDriven) {
      reason += ` — cognitive signal(s): ${session.cognitive_signals!.join(', ')}`
    }

    return {
      id: fixtureId,
      description: `Auto-collected: "${session.goal.slice(0, 60)}" — ${session.event_count} events, score=${gateScore.toFixed(2)}`,
      agent: session.agent,
      created_at: timestamp,
      source: 'auto_collected',
      auto_label: {
        drift: isDrift,
        confidence: isDrift
          ? (gateScore >= 0.85 ? 'high' : 'medium')
          : (gateScore <= 0.08 ? 'high' : 'medium'),
        final_score: session.final_score,
        composite_score: session.composite_score,
        cognitive_signals: cognitiveDriven ? session.cognitive_signals : undefined,
        reason,
      },
      session: {
        id: session.session_id,
        started_at: session.started_at,
        agent: session.agent,
        active_goal_id: goalId,
        goals: [{
          id: goalId,
          created_at: session.started_at,
          source: 'human',
          raw: session.goal,
          confirmed: true,
          status: isDrift ? 'forgotten' : 'active',
          subgoal_depth: 0,
        }],
        events: fixtureEvents,
      },
      needs_review: true,
    }
  }

  private extractTarget(event: CandidateEvent): string {
    const input = event.tool_input as Record<string, unknown> | undefined
    if (!input) return ''
    // Common target fields from various tools
    return String(
      input['relative_workspace_path']
      ?? input['file_path']
      ?? input['path']
      ?? input['command']
      ?? input['query']
      ?? ''
    ).slice(0, 200)
  }

  /**
   * Filter out goals that are clearly non-human-intent system artifacts.
   * Be conservative — only reject goals that cannot possibly be real user intent.
   * e.g. "fix startup hook error" IS a valid goal (user asked to fix it).
   */
  private isInvalidGoal(goal: string): boolean {
    const trimmed = goal.trim()
    const invalidPatterns = [
      /^undefined$/i,
      /^null$/i,
      /^\[Image #\d+\]$/,        // Pure image reference with no other text
    ]
    return invalidPatterns.some(pattern => pattern.test(trimmed))
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.config.outputDir)) return

    const files = fs.readdirSync(this.config.outputDir)
      .filter(f => f.startsWith('candidate_') && f.endsWith('.json'))
      .sort() // lexicographic — older timestamp-based IDs come first

    if (files.length >= this.config.maxCandidates) {
      // Remove oldest candidates to stay under limit
      const toRemove = files.slice(0, files.length - this.config.maxCandidates + 1)
      for (const file of toRemove) {
        fs.unlinkSync(path.join(this.config.outputDir, file))
      }
    }
  }
}
