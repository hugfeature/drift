/**
 * Tests for CompositeScorer — the layered-max fusion of v0.1 execution-layer
 * DriftScore and v0.2 cognitive-layer PrimarySignal[].
 *
 * Fusion contract (docs/rfc-scoring-and-authorization-roadmap.md §A3.1):
 *   composite = max(v0.1 score, any v0.2 hit ? cognitive_hit_floor : 0)
 *
 * The four-quadrant boundary matrix is the core of these tests:
 *   - neither layer fires        → aligned, source 'none'
 *   - only v0.1 fires            → execution score passes through, source 'execution'
 *   - only v0.2 fires            → lifted to floor (zero-FP signal never diluted), source 'cognitive'
 *   - both fire                  → max wins, source 'both'
 *
 * Inputs are hand-built DriftScore / PrimarySignal objects so each test pins
 * one fusion behaviour without coupling to the full scoring pipeline.
 */

import { CompositeScorer } from '../../src/scoring/composite'
import { DEFAULT_COMPOSITE_CONFIG } from '../../src/types/composite'
import type { DriftScore, DriftSignals } from '../../src/types/scoring'
import type { PrimarySignal } from '../../src/risk/types'

const EMPTY_SIGNALS: DriftSignals = {
  semantic_divergence:        0,
  inactive_duration_minutes:  0,
  consecutive_unrelated:      0,
  subgoal_depth:              0,
  exploratory_entropy:        0,
  unauthorized_mutations:     0,
  autonomy_momentum:          0,
  hallucinated_claims:        0,
  behavioral_pathology:       0,
}

function makeExecutionScore(score: number): DriftScore {
  const status = score >= 0.75 ? 'lost' : score >= 0.43 ? 'drifting' : 'aligned'
  return {
    score,
    status,
    signals:                 EMPTY_SIGNALS,
    computed_at:             1_700_000_000_000,
    contributing_event_ids:  [],
  }
}

function makeCognitiveSignal(): PrimarySignal {
  return {
    signal:                   'obligation_closure_check',
    first_registration_index: 3,
    obligation_type:          'create_task',
    required_obligations:     ['update_task(status=done)'],
    fulfilled_obligations:    [],
    missing_obligations:      ['update_task(status=done)'],
    completion_ratio:         0,
  }
}

describe('CompositeScorer — layered-max fusion', () => {
  const scorer = new CompositeScorer()

  // ──────────────────────────────────────────────────────────────────────────
  // Four-quadrant boundary matrix
  // ──────────────────────────────────────────────────────────────────────────

  it('neither layer fires → aligned, source none', () => {
    const result = scorer.fuse(makeExecutionScore(0), [])

    expect(result.score).toBe(0)
    expect(result.status).toBe('aligned')
    expect(result.source).toBe('none')
    expect(result.breakdown.cognitive_hit).toBe(false)
    expect(result.breakdown.cognitive_floor_applied).toBeNull()
  })

  it('only v0.1 fires → execution score passes through, source execution', () => {
    const result = scorer.fuse(makeExecutionScore(0.6), [])

    expect(result.score).toBeCloseTo(0.6)
    expect(result.status).toBe('drifting')
    expect(result.source).toBe('execution')
    expect(result.breakdown.cognitive_hit).toBe(false)
  })

  it('only v0.2 fires → lifted to floor, source cognitive (NOT diluted)', () => {
    const result = scorer.fuse(makeExecutionScore(0), [makeCognitiveSignal()])

    expect(result.score).toBe(DEFAULT_COMPOSITE_CONFIG.cognitive_hit_floor)
    expect(result.status).toBe('lost')
    expect(result.source).toBe('cognitive')
    expect(result.breakdown.cognitive_hit).toBe(true)
    expect(result.breakdown.cognitive_floor_applied).toBe(0.85)
  })

  it('both fire → max wins, source both', () => {
    // execution already in high band (0.9) > floor (0.85) → max is execution
    const result = scorer.fuse(makeExecutionScore(0.9), [makeCognitiveSignal()])

    expect(result.score).toBeCloseTo(0.9)
    expect(result.status).toBe('lost')
    expect(result.source).toBe('both')
    expect(result.breakdown.cognitive_hit).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // The core anti-dilution guarantee
  // ──────────────────────────────────────────────────────────────────────────

  it('zero-FP cognitive hit with low v0.1 score still lands in high-risk band', () => {
    // This is the case A2 recall must not lose at fusion time:
    // v0.1 sees nothing (0.1), but a cognitive signal fired.
    const result = scorer.fuse(makeExecutionScore(0.1), [makeCognitiveSignal()])

    expect(result.score).toBe(0.85)
    expect(result.status).toBe('lost')
    // averaging would have produced ~0.5 and possibly dropped below thresholds
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Status threshold boundaries
  // ──────────────────────────────────────────────────────────────────────────

  it('classifies status at composite thresholds (0.43 drifting, 0.75 lost)', () => {
    expect(scorer.fuse(makeExecutionScore(0.42), []).status).toBe('aligned')
    expect(scorer.fuse(makeExecutionScore(0.43), []).status).toBe('drifting')
    expect(scorer.fuse(makeExecutionScore(0.74), []).status).toBe('drifting')
    expect(scorer.fuse(makeExecutionScore(0.75), []).status).toBe('lost')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Explainability
  // ──────────────────────────────────────────────────────────────────────────

  it('produces a composite evidence chain naming the firing layer', () => {
    const result = scorer.fuse(makeExecutionScore(0.1), [makeCognitiveSignal()])

    expect(result.evidence.length).toBeGreaterThan(0)
    expect(result.evidence.every(e => e.signal === 'composite')).toBe(true)
    const cognitiveEvidence = result.evidence.find(e =>
      e.observation.includes('Cognitive-layer'))
    expect(cognitiveEvidence).toBeDefined()
    expect(cognitiveEvidence?.details).toContain('obligation_closure_check')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Config tunability
  // ──────────────────────────────────────────────────────────────────────────

  it('respects a custom cognitive_hit_floor', () => {
    const custom = new CompositeScorer({ cognitive_hit_floor: 0.6 })
    const result = custom.fuse(makeExecutionScore(0.2), [makeCognitiveSignal()])

    expect(result.score).toBe(0.6)
    expect(result.status).toBe('drifting')
  })

  it('deduplicates repeated cognitive signal names in evidence details', () => {
    const result = scorer.fuse(makeExecutionScore(0), [
      makeCognitiveSignal(),
      makeCognitiveSignal(),
    ])

    const cognitiveEvidence = result.evidence.find(e =>
      e.observation.includes('Cognitive-layer'))
    expect(cognitiveEvidence?.details).toEqual(['obligation_closure_check'])
  })
})
