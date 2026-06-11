/**
 * Composite Replay — the unified entry point that runs BOTH detection pipelines
 * over the same fixture and fuses them via CompositeScorer (RFC §A3).
 *
 * Why this script exists:
 *   - v0.1 lives in eval/runner.ts (SessionManager → DriftScore)
 *   - v0.2 lives in scripts/module-X.ts (normalizeEvents → runAllDetectors)
 *   They historically ran independently. This script is the convergence point:
 *   one fixture in → one CompositeRiskScore out.
 *
 * Single load source: eval/fixtures/case_*.json. These files carry BOTH the
 * ground-truth `label` (for P/R) and `session.events[]` (consumed by both
 * pipelines). Using fixtures-valid/ would only cover 20/28 strong cases;
 * fixtures/ covers 27/28.
 *
 * Reporting honors the STRONG-only rule (insight: imported raw-corpus scores
 * are an illusion). Headline P/R is the STRONG tier only.
 *
 * Usage:
 *   npx ts-node scripts/composite-replay.ts
 *   npx ts-node scripts/composite-replay.ts --floor=0.75   # tune cognitive floor
 *   npx ts-node scripts/composite-replay.ts --all          # also print ALL-tier (debug)
 */

import * as fs from 'fs'
import * as path from 'path'

import { SessionManager } from '../src/session/manager'
import { normalizeEvents } from '../src/risk/normalizer'
import { runAllDetectors } from '../src/risk/detectors'
import { CompositeScorer } from '../src/scoring/composite'
import { AuthorizationPolicy, type AuthorizationDecision } from '../src/governance/policy'
import type { CompositeRiskScore } from '../src/types/composite'
import type { DriftScore } from '../src/types/scoring'
import type { RawFixtureEvent } from '../src/risk/types'

const FIXTURES_DIR = path.join(__dirname, '..', 'eval', 'fixtures')
const MANIFEST_PATH = path.join(__dirname, '..', 'eval', 'manifest.json')
const MIN_EVENTS = 5

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

function parseFloorFlag(): number | undefined {
  const arg = process.argv.find(a => a.startsWith('--floor='))
  if (!arg) return undefined
  const value = Number(arg.split('=')[1])
  return Number.isFinite(value) ? value : undefined
}

const customFloor = parseFloorFlag()
const showAll = process.argv.includes('--all')
const showDist = process.argv.includes('--dist')
const showPolicy = process.argv.includes('--policy')

// ---------------------------------------------------------------------------
// Fixture loading (single source: eval/fixtures/)
// ---------------------------------------------------------------------------

interface LoadedFixture {
  id: string
  filePath: string
  raw: Record<string, any>
}

function loadFixtures(): LoadedFixture[] {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.startsWith('case_') && f.endsWith('.json'))
    .sort()

  const loaded: LoadedFixture[] = []
  for (const file of files) {
    const filePath = path.join(FIXTURES_DIR, file)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const events = raw.session?.events ?? []
    if (events.length < MIN_EVENTS) continue
    const id = raw.id ?? raw.case_id ?? path.basename(file, '.json')
    loaded.push({ id, filePath, raw })
  }
  return loaded
}

function loadStrongIds(): Set<string> {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as {
    strong: { ids: string[] }
  }
  return new Set(manifest.strong.ids)
}

// ---------------------------------------------------------------------------
// Ground-truth extraction
// ---------------------------------------------------------------------------

interface GroundTruth {
  drift: boolean
  worth_inspection: boolean
}

function extractGroundTruth(raw: Record<string, any>): GroundTruth {
  const label = raw.label ?? {}
  // Mirror module-X.ts ground-truth rule: taxonomy fixtures (FC-067/068,
  // case_06x) carry the label in failure_chain.root_failure.type, not in
  // label.drift. Reading label.drift alone misclassifies them as clean and
  // inflates the false-interception rate.
  const failureChainType = raw.failure_chain?.root_failure?.type
  return {
    drift:            Boolean(label.drift) || failureChainType != null,
    worth_inspection: Boolean(label.worth_inspection),
  }
}

// ---------------------------------------------------------------------------
// Pipeline 1 — v0.1 DriftScore via SessionManager
// ---------------------------------------------------------------------------

async function runExecutionPipeline(raw: Record<string, any>): Promise<DriftScore> {
  const session = new SessionManager({
    agent:        raw.agent ?? 'claude-code',
    session_id:   raw.session?.id,
    started_at:   raw.session?.started_at,
    langsmith:    false,
    verification: false,
  })

  const firstGoal = raw.session?.goals?.[0]
  if (firstGoal) {
    const goalId = session.setGoal(firstGoal.raw, firstGoal.created_at)
    if (firstGoal.normalized) {
      await session.confirmGoal(goalId, firstGoal.normalized)
    }
  }

  const replayableTypes = ['tool_call', 'subgoal_created', 'goal_mutated']
  const events = (raw.session?.events ?? []) as any[]

  let lastScore: DriftScore | null = null
  for (const evt of events) {
    if (!replayableTypes.includes(evt.type)) continue
    const result = await session.processEvent({
      type:      evt.type,
      source:    evt.source,
      payload:   evt.payload,
      goal_id:   evt.goal_id,
      timestamp: evt.timestamp,
    })
    lastScore = result.drift_score
  }

  return lastScore ?? emptyExecutionScore()
}

function emptyExecutionScore(): DriftScore {
  return {
    score:  0,
    status: 'aligned',
    signals: {
      semantic_divergence:        0,
      inactive_duration_minutes:  0,
      consecutive_unrelated:      0,
      subgoal_depth:              0,
      exploratory_entropy:        0,
      unauthorized_mutations:     0,
      autonomy_momentum:          0,
      hallucinated_claims:        0,
      behavioral_pathology:       0,
    },
    computed_at:            Date.now(),
    contributing_event_ids: [],
  }
}

// ---------------------------------------------------------------------------
// Pipeline 2 — v0.2 PrimarySignal[] via runAllDetectors
// ---------------------------------------------------------------------------

function extractGoalText(raw: Record<string, any>): string | undefined {
  const goals = raw.session?.goals ?? []
  const activeId = raw.session?.active_goal_id
  const active = activeId ? goals.find((g: any) => g.id === activeId) : goals[0]
  return active?.raw ?? active?.normalized?.observable_targets?.[0]
}

function extractPromptText(raw: Record<string, any>): string {
  return extractGoalText(raw) ?? ''
}

function runCognitivePipeline(raw: Record<string, any>) {
  const events = normalizeEvents((raw.session?.events ?? []) as RawFixtureEvent[])
  const goalText = extractGoalText(raw)
  const promptText = extractPromptText(raw)
  return runAllDetectors(events, goalText, promptText)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface FixtureResult {
  id: string
  strong: boolean
  ground_truth_drift: boolean
  worth_inspection: boolean
  composite: CompositeRiskScore
  predicted_drift: boolean
}

interface Metrics {
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number
  recall: number
  f1: number
  count: number
}

function computeMetrics(results: FixtureResult[]): Metrics {
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const r of results) {
    if (r.worth_inspection) continue // excluded from P/R by policy
    const predicted = r.predicted_drift
    const actual = r.ground_truth_drift
    if (predicted && actual) tp++
    else if (predicted && !actual) fp++
    else if (!predicted && actual) fn++
    else tn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, tn, precision, recall, f1, count: tp + fp + fn + tn }
}

function formatMetrics(label: string, m: Metrics): string {
  return [
    `${label} (n=${m.count}):`,
    `  TP=${m.tp}  FP=${m.fp}  FN=${m.fn}  TN=${m.tn}`,
    `  Precision: ${m.precision.toFixed(3)}`,
    `  Recall:    ${m.recall.toFixed(3)}`,
    `  F1:        ${m.f1.toFixed(3)}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fixtures = loadFixtures()
  const strongIds = loadStrongIds()
  const scorer = new CompositeScorer(
    customFloor !== undefined ? { cognitive_hit_floor: customFloor } : undefined,
  )

  console.log('Composite Replay — layered-max fusion of v0.1 + v0.2')
  console.log(`Fixtures loaded (≥${MIN_EVENTS} events): ${fixtures.length}`)
  console.log(`Cognitive floor: ${customFloor ?? 0.85}`)
  console.log('')

  const results: FixtureResult[] = []

  for (const fx of fixtures) {
    const executionScore = await runExecutionPipeline(fx.raw)
    const cognitiveSignals = runCognitivePipeline(fx.raw)
    const composite = scorer.fuse(executionScore, cognitiveSignals)
    const gt = extractGroundTruth(fx.raw)

    results.push({
      id:                 fx.id,
      strong:             strongIds.has(fx.id),
      ground_truth_drift: gt.drift,
      worth_inspection:   gt.worth_inspection,
      composite,
      predicted_drift:    composite.status !== 'aligned',
    })
  }

  const strongResults = results.filter(r => r.strong)

  console.log('═══ STRONG tier (headline) ═══')
  console.log(formatMetrics('STRONG', computeMetrics(strongResults)))
  console.log('')

  // Per-case score distribution — used to calibrate B1 ask/block thresholds
  if (showDist) {
    console.log('═══ STRONG score distribution (for B1 threshold calibration) ═══')
    const sorted = [...strongResults]
      .filter(r => !r.worth_inspection)
      .sort((a, b) => b.composite.score - a.composite.score)
    console.log('  score   status     gt_drift  source       id')
    for (const r of sorted) {
      const score = r.composite.score.toFixed(2)
      const status = r.composite.status.padEnd(8)
      const gt = (r.ground_truth_drift ? 'DRIFT' : 'clean').padEnd(8)
      const src = r.composite.source.padEnd(10)
      console.log(`  ${score}    ${status}   ${gt}  ${src}   ${r.id}`)
    }
    console.log('')
  }

  // Source attribution — how often each layer drove the composite (strong tier)
  const bySource = { execution: 0, cognitive: 0, both: 0, none: 0 }
  for (const r of strongResults) bySource[r.composite.source]++
  console.log('Composite source breakdown (STRONG):')
  console.log(`  execution-driven: ${bySource.execution}`)
  console.log(`  cognitive-driven: ${bySource.cognitive}`)
  console.log(`  both layers:      ${bySource.both}`)
  console.log(`  none (aligned):   ${bySource.none}`)
  console.log('')

  // Cases where cognitive layer alone caught a drift the execution score missed
  const cognitiveCatches = strongResults.filter(r =>
    r.composite.source === 'cognitive' &&
    r.composite.breakdown.execution_status === 'aligned' &&
    r.ground_truth_drift,
  )
  if (cognitiveCatches.length > 0) {
    console.log('Cognitive-only catches (v0.1 aligned, v0.2 caught a real drift):')
    for (const r of cognitiveCatches) {
      const signals = [...new Set(r.composite.breakdown.cognitive_signals.map(s => s.signal))]
      console.log(`  ${r.id} → ${signals.join(', ')}`)
    }
    console.log('')
  }

  // B1 — apply the authorization policy and measure false-interception rate
  if (showPolicy) {
    const policy = new AuthorizationPolicy()
    const evaluable = strongResults.filter(r => !r.worth_inspection)

    const byDecision: Record<AuthorizationDecision, { clean: number; drift: number }> = {
      auto:     { clean: 0, drift: 0 },
      ask_soft: { clean: 0, drift: 0 },
      ask:      { clean: 0, drift: 0 },
      block:    { clean: 0, drift: 0 },
    }

    for (const r of evaluable) {
      const verdict = policy.decide(r.composite)
      const bucket = r.ground_truth_drift ? 'drift' : 'clean'
      byDecision[verdict.decision][bucket]++
    }

    const totalClean = evaluable.filter(r => !r.ground_truth_drift).length
    const totalDrift = evaluable.filter(r => r.ground_truth_drift).length

    // Anything that pauses the agent (ask/ask_soft/block) on a clean session
    // is a false interception.
    const pausedClean =
      byDecision.ask.clean + byDecision.ask_soft.clean + byDecision.block.clean
    // A real drift that got `auto` is a missed interception.
    const autoedDrift = byDecision.auto.drift

    console.log('═══ B1 authorization policy (STRONG tier) ═══')
    console.log('  decision   clean  drift')
    console.log(`  auto        ${String(byDecision.auto.clean).padStart(4)}   ${byDecision.auto.drift}`)
    console.log(`  ask_soft    ${String(byDecision.ask_soft.clean).padStart(4)}   ${byDecision.ask_soft.drift}`)
    console.log(`  ask         ${String(byDecision.ask.clean).padStart(4)}   ${byDecision.ask.drift}`)
    console.log(`  block       ${String(byDecision.block.clean).padStart(4)}   ${byDecision.block.drift}`)
    console.log('')
    console.log(`  False-interception rate: ${pausedClean}/${totalClean} clean sessions paused = ${(pausedClean / totalClean * 100).toFixed(1)}%`)
    console.log(`    └─ of which high-confidence ask: ${byDecision.ask.clean}/${totalClean} = ${(byDecision.ask.clean / totalClean * 100).toFixed(1)}%`)
    console.log(`    └─ gray-zone ask_soft:          ${byDecision.ask_soft.clean}/${totalClean} = ${(byDecision.ask_soft.clean / totalClean * 100).toFixed(1)}%`)
    console.log(`  Missed-interception rate: ${autoedDrift}/${totalDrift} real drifts auto-proceeded = ${(autoedDrift / totalDrift * 100).toFixed(1)}%`)
    console.log('')
  }

  if (showAll) {
    console.log('═══ ALL tier (debug only — NOT the headline) ═══')
    console.log(formatMetrics('ALL', computeMetrics(results)))
  }
}

main().catch(err => {
  console.error('[composite-replay] error:', err)
  process.exit(1)
})
