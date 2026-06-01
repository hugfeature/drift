/**
 * Tests for AuthorizationPolicy — the track-B decision layer that maps a
 * composite risk score to {auto / ask_soft / ask / block}.
 *
 * Thresholds (DEFAULT_POLICY_CONFIG):
 *   score < 0.45            → auto
 *   0.45 ≤ score < 0.75     → ask_soft (gray zone, ~30% false-interception)
 *   score ≥ 0.75            → ask (high-confidence, ~0% false-interception)
 *   block is RESERVED — never emitted unless enable_block is set
 */

import { AuthorizationPolicy, DEFAULT_POLICY_CONFIG } from '../../src/governance/policy'
import type { CompositeRiskScore } from '../../src/types/composite'
import type { CompositeSource } from '../../src/types/composite'

function makeComposite(score: number, source: CompositeSource = 'execution'): CompositeRiskScore {
  const status = score >= 0.75 ? 'lost' : score >= 0.45 ? 'drifting' : 'aligned'
  return {
    score,
    status,
    source,
    breakdown: {
      execution_score:         source === 'cognitive' ? 0 : score,
      execution_status:        status,
      cognitive_hit:           source === 'cognitive' || source === 'both',
      cognitive_signals:       [],
      cognitive_floor_applied: source === 'cognitive' || source === 'both' ? score : null,
    },
    evidence:    [],
    computed_at: 1_700_000_000_000,
  }
}

describe('AuthorizationPolicy — score → decision bands', () => {
  const policy = new AuthorizationPolicy()

  it('auto below the soft threshold', () => {
    expect(policy.decide(makeComposite(0)).decision).toBe('auto')
    expect(policy.decide(makeComposite(0.44)).decision).toBe('auto')
  })

  it('ask_soft in the gray zone [0.45, 0.75)', () => {
    expect(policy.decide(makeComposite(0.45)).decision).toBe('ask_soft')
    expect(policy.decide(makeComposite(0.6)).decision).toBe('ask_soft')
    expect(policy.decide(makeComposite(0.74)).decision).toBe('ask_soft')
  })

  it('ask at/above the high-confidence threshold (0.75)', () => {
    expect(policy.decide(makeComposite(0.75)).decision).toBe('ask')
    expect(policy.decide(makeComposite(0.85)).decision).toBe('ask')
    expect(policy.decide(makeComposite(1.0)).decision).toBe('ask')
  })

  it('marks high_confidence only for the ask band', () => {
    expect(policy.decide(makeComposite(0.85)).high_confidence).toBe(true)
    expect(policy.decide(makeComposite(0.6)).high_confidence).toBe(false)
    expect(policy.decide(makeComposite(0.2)).high_confidence).toBe(false)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // block is reserved — never emitted by default
  // ──────────────────────────────────────────────────────────────────────────

  it('never emits block when enable_block is false (default)', () => {
    // Even a maximal score maps to ask, not block, in v1.
    expect(policy.decide(makeComposite(1.0)).decision).toBe('ask')
    expect(DEFAULT_POLICY_CONFIG.enable_block).toBe(false)
  })

  it('emits block only when explicitly enabled and above block_threshold', () => {
    const blocking = new AuthorizationPolicy({ enable_block: true, block_threshold: 0.95 })
    expect(blocking.decide(makeComposite(0.96)).decision).toBe('block')
    expect(blocking.decide(makeComposite(0.85)).decision).toBe('ask') // below block, still ask
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Reason text + cognitive attribution
  // ──────────────────────────────────────────────────────────────────────────

  it('reason names the cognitive layer when the score is cognitive-driven', () => {
    const verdict = policy.decide(makeComposite(0.85, 'cognitive'))
    expect(verdict.reason.toLowerCase()).toContain('cognitive')
  })

  it('requiresPause is true for every stopping decision', () => {
    expect(AuthorizationPolicy.requiresPause('auto')).toBe(false)
    expect(AuthorizationPolicy.requiresPause('ask_soft')).toBe(true)
    expect(AuthorizationPolicy.requiresPause('ask')).toBe(true)
    expect(AuthorizationPolicy.requiresPause('block')).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Config tunability
  // ──────────────────────────────────────────────────────────────────────────

  it('respects custom thresholds', () => {
    const strict = new AuthorizationPolicy({ ask_threshold: 0.5, ask_soft_threshold: 0.3 })
    expect(strict.decide(makeComposite(0.5)).decision).toBe('ask')
    expect(strict.decide(makeComposite(0.35)).decision).toBe('ask_soft')
    expect(strict.decide(makeComposite(0.25)).decision).toBe('auto')
  })
})
