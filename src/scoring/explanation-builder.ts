/**
 * ExplanationBuilder — transforms raw DriftScore into interpretable diagnostic trace.
 *
 * This is the "inference narration layer". It doesn't compute new signals —
 * it materializes existing signals into human-readable evidence chains.
 *
 * Design principles:
 *   1. Every explanation must cite specific evidence (not just thresholds)
 *   2. Evidence is ordered by contribution weight (most impactful first)
 *   3. Classification is inferred from signal patterns, not single thresholds
 *   4. Recommendations are actionable, not generic
 */

import type { RuntimeEvent } from '../types/event'
import type {
  BehavioralPathologySignals,
  DriftEvidence,
  DriftExplanation,
  DriftSeverity,
  DriftSignals,
  DriftScore,
} from '../types/scoring'

export class ExplanationBuilder {
  /**
   * Build a structured explanation from a DriftScore and its source events.
   * Returns undefined for aligned sessions (no explanation needed).
   */
  build(score: DriftScore, events: RuntimeEvent[]): DriftExplanation | undefined {
    if (score.status === 'aligned' && (!score.behavioral || score.behavioral.rabbit_hole_score < 0.55)) {
      return undefined
    }

    const classification = this.classifyDrift(score)
    const evidence = this.gatherEvidence(score, events)
    const severity = this.assessSeverity(score, classification)
    const summary = this.buildSummary(classification, severity, evidence)
    const firstObservedAt = this.findOnset(events, classification)
    const recommendation = this.recommend(classification, severity)

    return {
      classification,
      severity,
      summary,
      evidence,
      first_observed_at: firstObservedAt,
      recommendation,
    }
  }

  private classifyDrift(score: DriftScore): DriftExplanation['classification'] {
    const signals = score.signals
    const behavioral = score.behavioral

    // Rabbit hole: behavioral detector fires
    if (behavioral && behavioral.rabbit_hole_score >= 0.55) {
      // Pure rabbit hole vs mixed
      if (signals.semantic_divergence < 0.4) return 'rabbit_hole'
      return 'mixed'
    }

    // Autonomy runaway: high autonomy + moderate divergence
    if (signals.autonomy_momentum > 0.8 && signals.semantic_divergence > 0.3) {
      return 'autonomy_runaway'
    }

    // Goal forgotten: high consecutive unrelated + high inactive duration
    if (signals.consecutive_unrelated >= 5 || signals.inactive_duration_minutes > 10) {
      return 'goal_forgotten'
    }

    // Scope expansion: high divergence + low consecutive (agent is doing related-ish new things)
    if (signals.semantic_divergence > 0.5) {
      return 'scope_expansion'
    }

    // Aligned but with elevated signals
    return 'aligned'
  }

  private gatherEvidence(score: DriftScore, events: RuntimeEvent[]): DriftEvidence[] {
    const evidence: DriftEvidence[] = []
    const signals = score.signals
    const behavioral = score.behavioral

    // Semantic divergence evidence
    if (signals.semantic_divergence > 0.3) {
      evidence.push({
        signal: 'semantic_divergence',
        observation: `Actions diverge from goal by ${(signals.semantic_divergence * 100).toFixed(0)}%`,
        value: signals.semantic_divergence,
      })
    }

    // Autonomy momentum evidence
    if (signals.autonomy_momentum > 0.5) {
      const toolEvents = events.filter(e => e.type === 'tool_call')
      const totalEvents = events.length
      evidence.push({
        signal: 'autonomy_momentum',
        observation: `Agent running autonomously: ${toolEvents.length}/${totalEvents} events are tool calls (momentum: ${(signals.autonomy_momentum * 100).toFixed(0)}%)`,
        value: signals.autonomy_momentum,
      })
    }

    // Consecutive unrelated evidence
    if (signals.consecutive_unrelated >= 3) {
      evidence.push({
        signal: 'consecutive_unrelated',
        observation: `${signals.consecutive_unrelated} consecutive actions unrelated to active goal`,
        value: signals.consecutive_unrelated,
      })
    }

    // Behavioral pathology evidence
    if (behavioral && behavioral.rabbit_hole_score >= 0.4) {
      this.addBehavioralEvidence(behavioral, events, evidence)
    }

    // Exploratory entropy
    if (signals.exploratory_entropy > 0.6) {
      evidence.push({
        signal: 'exploratory_entropy',
        observation: `High tool usage entropy (${signals.exploratory_entropy.toFixed(2)}) — scattered exploration pattern`,
        value: signals.exploratory_entropy,
      })
    }

    // Sort by value descending (most extreme signals first)
    evidence.sort((a, b) => b.value - a.value)
    return evidence
  }

  private addBehavioralEvidence(
    behavioral: BehavioralPathologySignals,
    events: RuntimeEvent[],
    evidence: DriftEvidence[]
  ): void {
    // Target repetition — find the most repeated targets
    if (behavioral.target_repetition > 0.3) {
      const targets = this.extractTopTargets(events)
      evidence.push({
        signal: 'target_repetition',
        observation: `Repeated file operations: ${(behavioral.target_repetition * 100).toFixed(0)}% of actions hit already-visited targets`,
        value: behavioral.target_repetition,
        details: targets.slice(0, 3),
      })
    }

    // Novelty decay
    if (behavioral.novelty_rate < 0.3) {
      evidence.push({
        signal: 'novelty_rate',
        observation: `Novelty collapsed: only ${(behavioral.novelty_rate * 100).toFixed(0)}% of recent actions target new files`,
        value: 1 - behavioral.novelty_rate,
      })
    }

    // Progress stagnation
    if (behavioral.progress_stagnation > 0.5) {
      evidence.push({
        signal: 'progress_stagnation',
        observation: `Progress stalled: exploration-to-edit ratio indicates reading/running without producing changes`,
        value: behavioral.progress_stagnation,
      })
    }
  }

  private assessSeverity(score: DriftScore, classification: DriftExplanation['classification']): DriftSeverity {
    if (classification === 'aligned') return 'low'

    const compositeScore = score.score
    const behavioral = score.behavioral

    // Critical: rabbit hole with very high score + long session
    if (classification === 'rabbit_hole' && behavioral && behavioral.rabbit_hole_score > 0.75) {
      return 'critical'
    }

    if (compositeScore > 0.7) return 'critical'
    if (compositeScore > 0.5) return 'high'
    if (compositeScore > 0.35) return 'moderate'
    return 'low'
  }

  private buildSummary(
    classification: DriftExplanation['classification'],
    severity: DriftSeverity,
    evidence: DriftEvidence[]
  ): string {
    const topEvidence = evidence[0]

    switch (classification) {
      case 'rabbit_hole':
        return `Agent stuck in recursive loop — ${topEvidence?.observation ?? 'repeated operations without convergence'}`
      case 'scope_expansion':
        return `Agent expanding beyond original scope — ${topEvidence?.observation ?? 'actions diverging from goal'}`
      case 'goal_forgotten':
        return `Original goal abandoned — ${topEvidence?.observation ?? 'extended period without goal-aligned actions'}`
      case 'autonomy_runaway':
        return `Agent operating without oversight — ${topEvidence?.observation ?? 'high autonomy with goal divergence'}`
      case 'mixed':
        return `Multiple drift patterns detected — ${topEvidence?.observation ?? 'compound behavioral anomaly'}`
      case 'aligned':
        return `Elevated signals but within tolerance`
    }
  }

  private recommend(classification: DriftExplanation['classification'], severity: DriftSeverity): string | undefined {
    if (severity === 'low') return undefined

    switch (classification) {
      case 'rabbit_hole':
        return 'Interrupt agent and re-state the acceptance criteria. The agent is looping without converging.'
      case 'scope_expansion':
        return 'Review recent actions for unauthorized scope changes. Consider constraining allowed_domains.'
      case 'goal_forgotten':
        return 'Re-inject the original goal. The agent has lost track of the primary objective.'
      case 'autonomy_runaway':
        return 'Add a checkpoint. The agent is executing a long autonomous sequence without human validation.'
      case 'mixed':
        return 'Multiple issues detected. Pause the agent and review the trace evidence.'
      default:
        return undefined
    }
  }

  private findOnset(events: RuntimeEvent[], classification: DriftExplanation['classification']): number | undefined {
    if (classification === 'aligned') return undefined

    const toolEvents = events.filter(e => e.type === 'tool_call')
    if (toolEvents.length < 5) return undefined

    // Simple heuristic: find the point where the session's behavioral pattern shifts.
    // For rabbit_hole: where target repetition first exceeds 50% in a sliding window.
    // For others: return the first contributing event index.
    const windowSize = 10
    for (let i = windowSize; i < toolEvents.length; i++) {
      const window = toolEvents.slice(i - windowSize, i)
      const targets = window
        .map(e => String(e.payload['target'] ?? ''))
        .filter(t => t !== '')
      const uniqueRatio = targets.length > 0 ? new Set(targets).size / targets.length : 1
      if (uniqueRatio < 0.5) return i - windowSize
    }

    return undefined
  }

  private extractTopTargets(events: RuntimeEvent[]): string[] {
    const targetCounts = new Map<string, number>()
    const recentEvents = events.filter(e => e.type === 'tool_call').slice(-30)

    for (const event of recentEvents) {
      const target = String(event.payload['target'] ?? '')
      if (!target) continue
      const normalized = target.split('/').slice(-3).join('/')
      targetCounts.set(normalized, (targetCounts.get(normalized) ?? 0) + 1)
    }

    return [...targetCounts.entries()]
      .filter(([_, count]) => count > 2)
      .sort((a, b) => b[1] - a[1])
      .map(([target, count]) => `${target} (×${count})`)
  }
}
