/**
 * Risk Layer v0.1 — Offline Replay Runner
 * Per RFC §6: Load fixtures → normalize → detect → partition → aggregate.
 *
 * Usage: npx ts-node --transpile-only scripts/module-X.ts
 */

import { loadEligibleFixtures } from '../src/risk/loader'
import { normalizeEvents } from '../src/risk/normalizer'
import { extractWindows, partitionSignals } from '../src/risk/windows'
import { runAllDetectors } from '../src/risk/detectors'
import type {
  PrimarySignal,
  RiskAnnotation,
  TrajectoryRisk,
} from '../src/risk/types'
import type { LoadedFixture } from '../src/risk/loader'

const WINDOW_SIZE = 5

interface AggregateStats {
  totalFixtures: number
  fixturesWithRiskSignals: number
  signalPresenceRate: number
  perSignalCounts: Record<string, { risk: number; baseline: number; enrichment: number }>
  riskDistribution: Record<TrajectoryRisk, number>
  avgEventsPerFixture: number
}

function extractGoalText(fixture: LoadedFixture): string | undefined {
  const goals = fixture.raw.session?.goals
  if (!goals || goals.length === 0) return undefined

  const activeGoalId = fixture.raw.session?.active_goal_id
  const activeGoal = activeGoalId
    ? goals.find((g: { id: string; raw?: string; normalized?: { observable_targets?: string[] } }) => g.id === activeGoalId)
    : goals[0]

  return activeGoal?.raw ?? activeGoal?.normalized?.observable_targets?.[0]
}

/**
 * Extract the original user prompt text from a fixture.
 *
 * Used by the completion_coverage_gap detector to read quantity constraints
 * (e.g. "two test files"). Both the aggregate enrichment pass and the
 * v0.2 session-level pass must use the SAME extraction, otherwise the
 * completion_coverage_gap signal silently never fires in one of them.
 */
function extractPromptText(fixture: LoadedFixture): string {
  const goals = fixture.raw.session?.goals
  if (goals?.[0]?.raw) return goals[0].raw

  const fallback = fixture.raw as unknown as {
    agent_context?: { task?: string }
    description?: string
  }
  return fallback.agent_context?.task ?? fallback.description ?? ''
}

function classifyRisk(riskSignals: PrimarySignal[]): TrajectoryRisk {
  if (riskSignals.length >= 3) return 'HIGH'
  if (riskSignals.length >= 1) return 'MEDIUM'
  return 'LOW'
}

function runReplay(): void {
  const fixtures = loadEligibleFixtures()
  console.log(`\n=== Risk Layer v0.1 — Offline Replay ===`)
  console.log(`Eligible fixtures: ${fixtures.length}`)
  console.log(`Window size: ${WINDOW_SIZE}\n`)

  const annotations: RiskAnnotation[] = []
  const signalTypeCounts: Record<string, { risk: number; baseline: number }> = {
    stale_context: { risk: 0, baseline: 0 },
    retry_density: { risk: 0, baseline: 0 },
    trajectory_divergence: { risk: 0, baseline: 0 },
    completion_coverage_gap: { risk: 0, baseline: 0 },
    assertion_without_verification: { risk: 0, baseline: 0 },
    obligation_closure_check: { risk: 0, baseline: 0 },
  }

  let fixturesWithRiskSignals = 0
  let totalBaselineWindows = 0

  for (const fixture of fixtures) {
    const events = normalizeEvents(fixture.events)
    const goalText = extractGoalText(fixture)
    const promptText = extractPromptText(fixture)
    const allSignals = runAllDetectors(events, goalText, promptText)
    const windowResult = extractWindows(events, { windowSize: WINDOW_SIZE })
    const { riskSignals, baselineSignals } = partitionSignals(allSignals, windowResult)

    const trajectoryRisk = classifyRisk(riskSignals)

    if (riskSignals.length > 0) fixturesWithRiskSignals++

    // Count per-signal-type in risk vs baseline
    for (const signal of riskSignals) {
      signalTypeCounts[signal.signal].risk++
    }
    for (const signal of baselineSignals) {
      signalTypeCounts[signal.signal].baseline++
    }

    totalBaselineWindows += windowResult.baselineWindows.length

    annotations.push({
      case_id: fixture.caseId,
      total_events: events.length,
      failure_point_index: windowResult.failurePointIndex,
      risk_window_signals: riskSignals,
      baseline_window_signals: baselineSignals,
      trajectory_risk: trajectoryRisk,
      execution_length: { feature: 'execution_length', value: events.length },
    })
  }

  // Print per-fixture summary
  console.log('--- Per-fixture results ---')
  for (const annotation of annotations) {
    const riskTypes = annotation.risk_window_signals.map(s => s.signal).join(', ') || 'none'
    console.log(
      `  ${annotation.case_id}: events=${annotation.total_events} risk=${annotation.trajectory_risk} signals=[${riskTypes}]`,
    )
  }

  // Aggregate statistics
  console.log('\n--- Aggregate Statistics ---')
  const presenceRate = fixturesWithRiskSignals / fixtures.length
  console.log(`Signal presence rate: ${fixturesWithRiskSignals}/${fixtures.length} (${(presenceRate * 100).toFixed(1)}%)`)

  console.log('\nPer-signal enrichment:')
  for (const [signalName, counts] of Object.entries(signalTypeCounts)) {
    // Enrichment: (risk signal rate per window) / (baseline signal rate per window)
    // risk windows = fixtures.length (one per fixture)
    // baseline windows = totalBaselineWindows
    const riskRate = counts.risk / fixtures.length
    const baselineRate = totalBaselineWindows > 0 ? counts.baseline / totalBaselineWindows : 0
    const enrichment = baselineRate > 0 ? riskRate / baselineRate : (counts.risk > 0 ? Infinity : 0)

    console.log(
      `  ${signalName}: risk=${counts.risk} baseline=${counts.baseline} ` +
      `riskRate=${riskRate.toFixed(3)} baselineRate=${baselineRate.toFixed(4)} ` +
      `enrichment=${enrichment === Infinity ? '∞' : enrichment.toFixed(2)}`,
    )
  }

  // Risk distribution
  const riskDist: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 }
  for (const annotation of annotations) {
    riskDist[annotation.trajectory_risk]++
  }
  console.log(`\nRisk distribution: HIGH=${riskDist.HIGH} MEDIUM=${riskDist.MEDIUM} LOW=${riskDist.LOW}`)

  // Success criteria check
  const maxEnrichment = Math.max(
    ...Object.values(signalTypeCounts).map(c => {
      const riskRate = c.risk / fixtures.length
      const baselineRate = totalBaselineWindows > 0 ? c.baseline / totalBaselineWindows : 0
      return baselineRate > 0 ? riskRate / baselineRate : 0
    }),
  )
  console.log(`\nMax enrichment ratio: ${maxEnrichment.toFixed(2)}`)
  console.log(`Success criteria (enrichment > 1.5): ${maxEnrichment > 1.5 ? '✅ PASS' : '❌ NOT MET'}`)

  // ─────────────────────────────────────────────────────────────
  // v0.2 Session-Level Evaluation
  // v0.2 signals detect cognitive-layer failures at session scope,
  // not within small windows. Evaluate with precision/recall.
  // ─────────────────────────────────────────────────────────────
  console.log('\n\n=== v0.2 Session-Level Evaluation ===')

  const V02_SIGNALS = new Set([
    'assertion_without_verification',
    'completion_coverage_gap',
    'obligation_closure_check',
  ])

  // Drift types that v0.2 cognitive signals are DESIGNED to detect.
  // These are completion/verification/closure failures — the agent claims
  // done, relaxes a constraint, or skips verification.
  //
  // Types NOT in this set (rabbit_hole, scope_expansion, cleanup_spiral,
  // goal_forgotten, interrupted_workflow, unauthorized_mutation) are
  // runtime/behavioral failures that live OUTSIDE v0.2's design scope. A
  // missed detection on those is NOT a false negative for v0.2 — it is
  // out-of-scope. Folding them into recall makes the metric lie: it counts
  // "not designed to catch this" as "failed to catch this".
  const V02_IN_SCOPE_DRIFT_TYPES = new Set([
    'incomplete_followthrough',
    'constraint_relaxation',
    'constraint_relaxation_without_approval',
    'goal_narrowing',
    'false_environment_assumption',
  ])

  function extractDriftType(fixture: LoadedFixture): string {
    const raw = fixture.raw as {
      label?: { drift_type?: string }
      failure_chain?: { root_failure?: { type?: string } }
    }
    return raw.label?.drift_type
      ?? raw.failure_chain?.root_failure?.type
      ?? '(none)'
  }

  interface SessionResult {
    caseId: string
    labeledDrift: boolean
    driftType: string
    inScope: boolean
    v02Signals: string[]
    v02Fired: boolean
  }

  const sessionResults: SessionResult[] = []

  for (const fixture of fixtures) {
    const events = normalizeEvents(fixture.events)
    const goalText = extractGoalText(fixture)
    const promptText = extractPromptText(fixture)

    const allSignals = runAllDetectors(events, goalText, promptText)
    const v02Hits = allSignals.filter(s => V02_SIGNALS.has(s.signal))
    const uniqueSignals = [...new Set(v02Hits.map(s => s.signal))]

    const labeledDrift = fixture.raw.label?.drift === true
      || fixture.raw.failure_chain?.root_failure?.type != null

    const driftType = extractDriftType(fixture)

    sessionResults.push({
      caseId: fixture.caseId,
      labeledDrift,
      driftType,
      inScope: V02_IN_SCOPE_DRIFT_TYPES.has(driftType),
      v02Signals: uniqueSignals,
      v02Fired: uniqueSignals.length > 0,
    })
  }

  // Compute precision/recall
  const truePositives = sessionResults.filter(r => r.v02Fired && r.labeledDrift)
  const falsePositives = sessionResults.filter(r => r.v02Fired && !r.labeledDrift)
  const falseNegatives = sessionResults.filter(r => !r.v02Fired && r.labeledDrift)
  const trueNegatives = sessionResults.filter(r => !r.v02Fired && !r.labeledDrift)

  const precision = truePositives.length / (truePositives.length + falsePositives.length || 1)

  // Naive recall: counts EVERY labeled drift as a recall target, including
  // drift types v0.2 was never designed to detect. Kept for continuity but
  // it systematically understates the detector — read scopedRecall instead.
  const recall = truePositives.length / (truePositives.length + falseNegatives.length || 1)
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

  // Scoped recall: the honest metric. Denominator = labeled drifts whose
  // type is within v0.2's design scope. This separates "missed something we
  // target" from "ignored something we never targeted".
  const inScopeDrift = sessionResults.filter(r => r.labeledDrift && r.inScope)
  const inScopeMissed = falseNegatives.filter(r => r.inScope)
  const outOfScopeMissed = falseNegatives.filter(r => !r.inScope)
  const inScopeCaught = inScopeDrift.length - inScopeMissed.length
  const scopedRecall = inScopeDrift.length > 0
    ? inScopeCaught / inScopeDrift.length
    : 0

  console.log(`\nCorpus: ${sessionResults.length} fixtures`)
  console.log(`Labeled drift=true: ${sessionResults.filter(r => r.labeledDrift).length}`)
  console.log(`  ├─ in v0.2 scope:     ${inScopeDrift.length}`)
  console.log(`  └─ out of v0.2 scope: ${sessionResults.filter(r => r.labeledDrift && !r.inScope).length}`)
  console.log(`v0.2 signal fired: ${sessionResults.filter(r => r.v02Fired).length}`)

  console.log('\nConfusion matrix:')
  console.log(`  TP=${truePositives.length}  FP=${falsePositives.length}`)
  console.log(`  FN=${falseNegatives.length}  TN=${trueNegatives.length}`)

  console.log(`\nPrecision:      ${(precision * 100).toFixed(1)}%`)
  console.log(`Recall (naive): ${(recall * 100).toFixed(1)}%   (denominator = ALL labeled drift)`)
  console.log(`Recall (scoped):${(scopedRecall * 100).toFixed(1)}%   (denominator = in-scope drift only: ${inScopeCaught}/${inScopeDrift.length})`)
  console.log(`F1 (naive):     ${(f1 * 100).toFixed(1)}%`)

  if (truePositives.length > 0) {
    console.log('\nTrue Positives (correct detections):')
    for (const r of truePositives) {
      console.log(`  ✅ ${r.caseId.padEnd(45)} ${r.v02Signals.join(', ')}`)
    }
  }

  if (falsePositives.length > 0) {
    console.log('\nFalse Positives (investigate):')
    for (const r of falsePositives) {
      console.log(`  ⚠️  ${r.caseId.padEnd(45)} ${r.v02Signals.join(', ')}`)
    }
  }

  if (inScopeMissed.length > 0) {
    console.log('\nIn-scope False Negatives (REAL misses — v0.2 should catch these):')
    for (const r of inScopeMissed) {
      console.log(`  ❌ ${r.caseId.padEnd(45)} type=${r.driftType}`)
    }
  } else {
    console.log('\nIn-scope False Negatives: none — every in-scope drift was caught ✅')
  }

  if (outOfScopeMissed.length > 0) {
    console.log(`\nOut-of-scope misses (${outOfScopeMissed.length}) — runtime/behavioral drift NOT in v0.2 design scope:`)
    const byType = new Map<string, number>()
    for (const r of outOfScopeMissed) {
      byType.set(r.driftType, (byType.get(r.driftType) ?? 0) + 1)
    }
    for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ·  ${type.padEnd(40)} ${count}`)
    }
  }

  console.log(`\nv0.2 success criteria (precision ≥ 80%):     ${precision >= 0.8 ? '✅ PASS' : '❌ NOT MET'}`)
  console.log(`v0.2 success criteria (scoped recall ≥ 80%): ${scopedRecall >= 0.8 ? '✅ PASS' : '❌ NOT MET'}`)
}

runReplay()
