/**
 * AuthorizationPolicy — maps a composite risk score to an authorization
 * decision. This is the decision layer of track B (RFC stage B1).
 *
 * The policy consumes the single composite number produced by CompositeScorer
 * (track A's closer) and emits one of:
 *
 *   auto      — proceed autonomously, no human in the loop
 *   ask_soft  — pause and ask the user, flagged low-confidence (gray zone)
 *   ask       — pause and ask the user, high-confidence interception
 *   block     — hard deny (RESERVED — not emitted by the first version)
 *
 * ## Why three "stop" bands instead of one
 *
 * STRONG-tier replay (scripts/composite-replay.ts --dist, 2026-06-01) shows the
 * false-interception risk is NOT uniform across the score range:
 *
 *   score ≥ 0.75 (lost)      → 0 / N clean sessions land here  → 0% mis-stop
 *   0.45 ≤ score < 0.75      → 3 / 10 clean sessions land here → ~30% mis-stop
 *   score < 0.45 (aligned)   → 7 / 10 clean sessions, all correctly auto
 *
 * So the high band can `ask` with near-zero cost, while the gray band must be
 * marked `ask_soft` so downstream UX can treat it as a softer nudge. This is
 * the layered-defense principle applied to authorization, not just detection.
 *
 * ## Why no `block` in v1
 *
 * Frozen decision (insight_permission_gradient_to_risk_layer, 2026-06-01):
 * first enforcement version ships `ask` only. An `ask` misjudgment costs one
 * extra question; a `block` misjudgment hard-kills the agent. `block` stays in
 * the type so B2 can wire it later, but the default policy never emits it.
 */

import type { CompositeRiskScore } from '../types/composite'

export type AuthorizationDecision = 'auto' | 'ask_soft' | 'ask' | 'block'

export interface PolicyConfig {
  /** At/above this score → high-confidence `ask` (default 0.75, the lost band) */
  ask_threshold: number
  /** At/above this score (but below ask_threshold) → `ask_soft` (default 0.45) */
  ask_soft_threshold: number
  /**
   * Master switch for hard `block`. When false (default), the policy never
   * emits `block` — high-risk maps to `ask`. Reserved for B2.
   */
  enable_block: boolean
  /** At/above this score → `block` when enable_block is true (default 0.95) */
  block_threshold: number
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  ask_threshold:      0.75,
  ask_soft_threshold: 0.45,
  enable_block:       false,
  block_threshold:    0.95,
}

export interface AuthorizationVerdict {
  decision: AuthorizationDecision
  /** The composite score this verdict was derived from */
  score: number
  /**
   * Whether this interception is in the empirically high-confidence band
   * (>= ask_threshold, ~0% false-interception on STRONG tier).
   */
  high_confidence: boolean
  /** Human-readable reason, ready to show the user when asking */
  reason: string
}

export class AuthorizationPolicy {
  private config: PolicyConfig

  constructor(config?: Partial<PolicyConfig>) {
    this.config = { ...DEFAULT_POLICY_CONFIG, ...config }
  }

  /**
   * Decide what to do given a composite risk score.
   * The optional cognitive flag lets the caller note that the score was lifted
   * by a zero-FP cognitive signal, which strengthens the reason text.
   */
  decide(composite: CompositeRiskScore): AuthorizationVerdict {
    const score = composite.score
    const cognitiveDriven = composite.source === 'cognitive' || composite.source === 'both'

    if (this.config.enable_block && score >= this.config.block_threshold) {
      return {
        decision:        'block',
        score,
        high_confidence: true,
        reason:          `Risk ${score.toFixed(2)} at/above block threshold ${this.config.block_threshold} — action denied`,
      }
    }

    if (score >= this.config.ask_threshold) {
      return {
        decision:        'ask',
        score,
        high_confidence: true,
        reason:          cognitiveDriven
          ? `Cognitive-layer risk signal fired (zero-FP) — composite ${score.toFixed(2)}. Confirm before proceeding.`
          : `High drift risk ${score.toFixed(2)} (>= ${this.config.ask_threshold}). Confirm before proceeding.`,
      }
    }

    if (score >= this.config.ask_soft_threshold) {
      return {
        decision:        'ask_soft',
        score,
        high_confidence: false,
        reason:          `Elevated drift risk ${score.toFixed(2)} (gray zone ${this.config.ask_soft_threshold}–${this.config.ask_threshold}). Optional check recommended.`,
      }
    }

    return {
      decision:        'auto',
      score,
      high_confidence: false,
      reason:          `Drift risk ${score.toFixed(2)} below ask threshold — proceeding autonomously`,
    }
  }

  /** Whether a verdict means the agent should pause for the user. */
  static requiresPause(decision: AuthorizationDecision): boolean {
    return decision === 'ask' || decision === 'ask_soft' || decision === 'block'
  }
}
