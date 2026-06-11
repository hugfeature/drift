/**
 * Composite Risk Scorer — fuses v0.1 execution-layer DriftScore with v0.2
 * cognitive-layer PrimarySignal[] into a single CompositeRiskScore.
 *
 * Fusion strategy: layered-max (frozen in
 * docs/rfc-scoring-and-authorization-roadmap.md §A3.1).
 *
 *   composite = max(
 *     v0.1 continuous score,                 // execution-layer drift magnitude
 *     any v0.2 hit ? cognitive_hit_floor : 0 // cognitive hit → lift to high band
 *   )
 *
 * v0.2 signals are zero-FP by construction, so a single hit is treated as
 * board-certain evidence and lifts the composite to the high-risk band rather
 * than being averaged down. When v0.2 is silent the composite degrades to the
 * trustworthy v0.1 continuous score.
 */

import type { DriftScore, DriftStatus, DriftEvidence } from '../types/scoring'
import type { PrimarySignal } from '../risk/types'
import {
  type CompositeRiskScore,
  type CompositeConfig,
  type CompositeSource,
  type CompositeBreakdown,
  DEFAULT_COMPOSITE_CONFIG,
} from '../types/composite'

/**
 * The v0.2 cognitive-layer signals validated at zero-FP. ONLY these are allowed
 * to lift the composite to the cognitive floor.
 *
 * Whitelist discipline (the project's iron rule): a signal enters this set ONLY
 * after composite-replay confirms it adds zero FP on the STRONG tier. Verified
 * via `npx ts-node scripts/composite-replay.ts`:
 *   - original 3 (assertion_without_verification / completion_coverage_gap /
 *     obligation_closure_check): RFC §C.2, precision 100%.
 *   - added 4 (premature_completion_claim / constraint_violation /
 *     goal_enumeration_coverage / goal_abandonment): re-replayed 2026-06-11 —
 *     adding them lifts STRONG recall 0.675→0.875 (+8 TP) while FP stays 0
 *     across 12 aligned-session TNs. Net gain, not redundant overlap.
 *
 * runAllDetectors() also emits stale_context / retry_density /
 * trajectory_divergence / repair_cycle_density — but those are execution-layer
 * (already in the v0.1 continuous score) and NOT zero-FP. Letting them trigger
 * the floor inflates false positives (verified: doing so dropped STRONG-tier
 * precision 0.727→0.583). They are deliberately excluded from the cognitive-hit
 * set. Any future signal must clear the same replay gate before being added here.
 */
const COGNITIVE_HIT_SIGNALS: ReadonlySet<PrimarySignal['signal']> = new Set([
  'assertion_without_verification',
  'completion_coverage_gap',
  'obligation_closure_check',
  'premature_completion_claim',
  'constraint_violation',
  'goal_enumeration_coverage',
  'goal_abandonment',
])

function isCognitiveHit(signal: PrimarySignal): boolean {
  return COGNITIVE_HIT_SIGNALS.has(signal.signal)
}

export class CompositeScorer {
  private config: CompositeConfig

  constructor(config?: Partial<CompositeConfig>) {
    this.config = { ...DEFAULT_COMPOSITE_CONFIG, ...config }
  }

  /**
   * Fuse the two pipeline outputs into one composite risk score.
   *
   * @param executionScore  v0.1 DriftScore from DriftScorer (session-level)
   * @param cognitiveSignals v0.2 PrimarySignal[] from runAllDetectors
   */
  fuse(executionScore: DriftScore, cognitiveSignals: PrimarySignal[]): CompositeRiskScore {
    // Only the zero-FP cognitive signals lift the composite. Execution-layer
    // signals that runAllDetectors also emits (stale_context / retry_density /
    // trajectory_divergence) are ignored here — they live in the v0.1 score.
    const cognitiveHits = cognitiveSignals.filter(isCognitiveHit)
    const cognitiveHit = cognitiveHits.length > 0
    const floorApplied = cognitiveHit ? this.config.cognitive_hit_floor : null

    const executionContribution = executionScore.score
    const cognitiveContribution = cognitiveHit ? this.config.cognitive_hit_floor : 0

    const score = Math.max(executionContribution, cognitiveContribution)
    const status = this.classifyStatus(score)
    const source = this.resolveSource(executionContribution, cognitiveContribution, cognitiveHit)

    const breakdown: CompositeBreakdown = {
      execution_score:         executionScore.score,
      execution_status:        executionScore.status,
      cognitive_hit:           cognitiveHit,
      cognitive_signals:       cognitiveHits,
      cognitive_floor_applied: floorApplied,
    }

    const evidence = this.buildEvidence(executionScore, cognitiveHits, source, score)

    return {
      score,
      status,
      source,
      breakdown,
      evidence,
      computed_at: Date.now(),
    }
  }

  /**
   * Classify status from the fused score using composite thresholds.
   * Mirrors DriftScorer.classifyStatus so behavior is consistent across layers.
   */
  private classifyStatus(score: number): DriftStatus {
    if (score >= this.config.lost_score_threshold)     return 'lost'
    if (score >= this.config.drifting_score_threshold) return 'drifting'
    return 'aligned'
  }

  /**
   * Determine which layer drove the final value, for explainability.
   * 'both' when the cognitive floor is applied AND the execution score is
   * already in the same high band (they reinforce rather than one masking).
   */
  private resolveSource(
    executionContribution: number,
    cognitiveContribution: number,
    cognitiveHit: boolean,
  ): CompositeSource {
    if (!cognitiveHit && executionContribution === 0) return 'none'
    if (!cognitiveHit) return 'execution'
    if (executionContribution >= cognitiveContribution) return 'both'
    return 'cognitive'
  }

  /**
   * Build an explanation chain that traces the composite back to its drivers.
   * Reuses DriftEvidence (signal='composite' is an allowed literal).
   */
  private buildEvidence(
    executionScore: DriftScore,
    cognitiveSignals: PrimarySignal[],
    source: CompositeSource,
    score: number,
  ): DriftEvidence[] {
    const evidence: DriftEvidence[] = []

    if (source === 'none') {
      evidence.push({
        signal:      'composite',
        observation: 'No execution-layer drift and no cognitive-layer signal — session aligned',
        value:       score,
      })
      return evidence
    }

    if (source === 'execution' || source === 'both') {
      evidence.push({
        signal:      'composite',
        observation: `Execution-layer drift score ${executionScore.score.toFixed(2)} (status: ${executionScore.status})`,
        value:       executionScore.score,
      })
    }

    if (cognitiveSignals.length > 0) {
      const signalNames = [...new Set(cognitiveSignals.map(s => s.signal))]
      evidence.push({
        signal:      'composite',
        observation:
          `Cognitive-layer signal(s) fired (zero-FP, lifted composite to floor ` +
          `${this.config.cognitive_hit_floor.toFixed(2)}): ${signalNames.join(', ')}`,
        value:       this.config.cognitive_hit_floor,
        details:     signalNames,
      })
    }

    return evidence
  }
}
