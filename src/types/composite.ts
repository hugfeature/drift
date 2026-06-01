/**
 * Composite Risk Score — fuses the two independent detection pipelines into
 * one consumable number.
 *
 * Drift has two scoring pipelines that historically ran independently:
 *
 *   v0.1 execution layer  (src/scoring/scorer.ts)
 *       → DriftScore { score: 0-1 continuous, status, 8 semantic + 3 behavioral signals }
 *       → measures HOW the agent executes (semantic divergence, autonomy, rabbit hole)
 *
 *   v0.2 cognitive layer  (src/risk/detectors/)
 *       → PrimarySignal[] discrete session-level hits, precision 100% / 0 FP
 *       → measures WHETHER the agent did the wrong/incomplete thing despite flawless execution
 *
 * The composite layer answers: "what is the single risk number for this session?"
 *
 * ## Fusion strategy: layered-max (NOT weighted average / weighted-OR)
 *
 * v0.2 signals have 0 false positives by construction — a single hit is
 * board-certain evidence of cognitive-layer drift. Averaging would dilute this
 * (a case with v0.1 score 0 but a v0.2 hit must NOT collapse to a low composite,
 * or the recall A2 worked to recover is lost again at fusion time).
 *
 * Therefore:
 *
 *   composite = max(
 *     v0.1 continuous score,                       // execution-layer drift magnitude
 *     any v0.2 hit ? cognitive_hit_floor : 0       // cognitive-layer hit → lift to high band
 *   )
 *
 * When v0.2 fires, composite is lifted to `cognitive_hit_floor` (default 0.85,
 * above the lost threshold 0.75) so the zero-FP strong signal is never drowned.
 * When v0.2 is silent, composite degrades gracefully to the trustworthy v0.1
 * continuous score. Each layer governs its own failure domain — whoever finds a
 * problem wins. This is the "layered defense" framing from
 * docs/rfc-risk-layer-v0.1.md §C.5.
 */

import type { DriftScore, DriftStatus, DriftEvidence } from './scoring'
import type { PrimarySignal } from '../risk/types'

/**
 * Which pipeline drove the final composite value.
 *   execution        — v0.1 continuous score was the max
 *   cognitive        — a v0.2 hit lifted the score to the cognitive floor
 *   both             — both layers contributed and tied at the floor band
 *   none             — neither layer flagged anything (aligned)
 */
export type CompositeSource = 'execution' | 'cognitive' | 'both' | 'none'

/**
 * Per-layer breakdown of what each pipeline contributed to the composite.
 * Keeps the composite explainable — every number can be traced back to a layer.
 */
export interface CompositeBreakdown {
  /** v0.1 continuous execution-layer score (0-1), as produced by DriftScorer */
  execution_score: number
  /** v0.1 status classification at its own thresholds */
  execution_status: DriftStatus
  /** Whether any v0.2 cognitive-layer signal fired in this session */
  cognitive_hit: boolean
  /** The v0.2 signals that fired (empty when cognitive_hit is false) */
  cognitive_signals: PrimarySignal[]
  /** The floor value v0.2 lifts the composite to when it fires */
  cognitive_floor_applied: number | null
}

/**
 * The unified risk number consumed by the authorization layer (track B).
 *
 * This is the single input B1's policy layer maps to {auto / ask / block}.
 * It carries enough breakdown to render an explanation when asking the user.
 */
export interface CompositeRiskScore {
  /** Final fused risk in [0, 1]. The one number downstream consumers read. */
  score: number
  /** Status derived from `score` against composite thresholds */
  status: DriftStatus
  /** Which layer drove the final value */
  source: CompositeSource
  /** Per-layer contribution breakdown */
  breakdown: CompositeBreakdown
  /** Explanation chain (reuses DriftEvidence with signal='composite' allowed) */
  evidence: DriftEvidence[]
  /** When this composite was computed (epoch ms) */
  computed_at: number
}

/**
 * Tunable config for composite fusion, mirroring the ScorerConfig pattern in
 * src/scoring/scorer.ts so thresholds stay eval-driven, not hard-coded.
 */
export interface CompositeConfig {
  /**
   * Value the composite is lifted to when any v0.2 cognitive signal fires.
   * Default 0.85 — above lost_score_threshold (0.75) so a zero-FP cognitive
   * hit always lands in the high-risk band. Adjusted via STRONG-tier replay.
   */
  cognitive_hit_floor: number
  /** Composite score at/above which status is 'drifting'. Mirrors v0.1 0.45. */
  drifting_score_threshold: number
  /** Composite score at/above which status is 'lost'. Mirrors v0.1 0.75. */
  lost_score_threshold: number
}

export const DEFAULT_COMPOSITE_CONFIG: CompositeConfig = {
  cognitive_hit_floor:      0.85,
  drifting_score_threshold: 0.45,
  lost_score_threshold:     0.75,
}
