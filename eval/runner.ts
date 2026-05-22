/**
 * Eval runner: validates DriftScorer against labeled fixtures.
 *
 * For each fixture:
 *   1. Replay the session event-by-event through the full pipeline
 *   2. Compare detected drift against human labels
 *   3. Report per-fixture result and aggregate metrics
 *
 * Run: npx ts-node eval/runner.ts
 *
 * Output:
 *   fixture_001  PASS  drift=true  score=0.79  type=scope_expansion
 *   fixture_002  FAIL  expected drift=true, got drift=false  score=0.41
 *   ...
 *   Precision: 0.87  Recall: 0.80  F1: 0.83
 */

import * as fs   from 'fs'
import * as path from 'path'
import { SessionManager } from '../src/session/manager'
import { OllamaEmbeddingProvider } from '../src/embedding/ollama-provider'
import type { EmbeddingProvider } from '../src/embedding/provider'
import type { EvalFixture } from '../src/types/eval'
import type { RawEvent }    from '../src/events/ingestion'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function loadFixtures(dir: string): EvalFixture[] {
  const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json'))
  return files.map((f: string) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8')
    return JSON.parse(raw) as EvalFixture
  })
}

// ---------------------------------------------------------------------------
// Replay a fixture through the pipeline
// ---------------------------------------------------------------------------

interface SignalBreakdown {
  semantic_divergence:    number
  inactive_duration_minutes: number
  consecutive_unrelated:  number
  subgoal_depth:          number
  exploratory_entropy:    number
  unauthorized_mutations: number
  autonomy_momentum:      number
  hallucinated_claims:    number
}

interface WeightedContribution {
  signal: string
  raw_value: number
  weighted: number
}

interface ReplayResult {
  fixture_id:     string
  final_score:    number
  drift_detected: boolean
  drift_status:   string
  takeover_rec:   boolean
  narrative:      string[]
  signals:        SignalBreakdown | null
  weighted_contributions: WeightedContribution[]
  dominant_signal: string
}

// Shared embedding provider — reuse across all fixtures to avoid re-init
const useOllama = process.argv.includes('--ollama')
  || Boolean(process.env.DRIFT_EMBEDDING_OLLAMA)
const sharedEmbedding: EmbeddingProvider | undefined = useOllama
  ? new OllamaEmbeddingProvider()
  : undefined

async function replayFixture(fixture: EvalFixture): Promise<ReplayResult> {
  const session = new SessionManager({
    agent:      fixture.agent,
    session_id: fixture.session.id,
    started_at: fixture.session.started_at,
    embedding:    sharedEmbedding,
    langsmith:    false,
    verification: false,
  })

  // Register the first goal
  const firstGoal = fixture.session.goals[0]
  if (firstGoal) {
    const goalId = session.setGoal(firstGoal.raw, firstGoal.created_at)
    if (firstGoal.normalized) {
      await session.confirmGoal(goalId, firstGoal.normalized)
    }
  }

  // Replay events (skip goal_created / goal_confirmed — already handled above)
  const replayableTypes = ['tool_call', 'subgoal_created', 'goal_mutated']
  const events = (fixture.session as any).events as any[] ?? []

  let lastResult: Awaited<ReturnType<typeof session.processEvent>> | null = null

  for (const evt of events) {
    if (!replayableTypes.includes(evt.type)) continue

    const raw: Omit<RawEvent, 'session_id'> = {
      type:      evt.type,
      source:    evt.source,
      payload:   evt.payload,
      goal_id:   evt.goal_id,
      timestamp: evt.timestamp,
    }

    lastResult = await session.processEvent(raw)
  }

  const finalScore    = lastResult?.drift_score.score ?? 0
  const driftDetected = finalScore >= 0.5
  const narrative     = session.getNarrative().segments.map(s => s.summary)
  const takeoverRec   = lastResult?.takeover.recommended ?? false

  // Extract signal breakdown for FP analysis
  const signals: SignalBreakdown | null = lastResult?.drift_score.signals
    ? { ...lastResult.drift_score.signals }
    : null

  // Compute weighted contributions per signal
  const defaultWeights: Record<string, number> = {
    semantic_divergence:    0.22,
    inactive_duration:      0.13,
    consecutive_unrelated:  0.13,
    subgoal_depth:          0.05,
    exploratory_entropy:    0.10,
    unauthorized_mutations: 0.05,
    autonomy_momentum:      0.22,
    hallucinated_claims:    0.10,
  }

  const contributions: WeightedContribution[] = signals
    ? computeWeightedContributions(signals, defaultWeights)
    : []

  const dominantSignal = contributions.length > 0
    ? contributions.reduce((max, c) => c.weighted > max.weighted ? c : max).signal
    : 'none'

  return {
    fixture_id:     fixture.id,
    final_score:    finalScore,
    drift_detected: driftDetected,
    drift_status:   lastResult?.drift_score.status ?? 'aligned',
    takeover_rec:   takeoverRec,
    narrative,
    signals,
    weighted_contributions: contributions,
    dominant_signal: dominantSignal,
  }
}

function computeWeightedContributions(
  signals: SignalBreakdown,
  weights: Record<string, number>
): WeightedContribution[] {
  const signalMap: Record<string, number> = {
    semantic_divergence:    signals.semantic_divergence,
    inactive_duration:      Math.min(signals.inactive_duration_minutes / 10, 1.0),
    consecutive_unrelated:  Math.min(signals.consecutive_unrelated / 5, 1.0),
    subgoal_depth:          Math.min(signals.subgoal_depth / 3, 1.0),
    exploratory_entropy:    signals.exploratory_entropy,
    unauthorized_mutations: Math.min(signals.unauthorized_mutations, 1.0),
    autonomy_momentum:      signals.autonomy_momentum,
    hallucinated_claims:    Math.min(signals.hallucinated_claims / 3, 1.0),
  }

  return Object.entries(signalMap)
    .map(([signal, rawValue]) => ({
      signal,
      raw_value: Math.round(rawValue * 1000) / 1000,
      weighted: Math.round(rawValue * (weights[signal] ?? 0) * 1000) / 1000,
    }))
    .sort((a, b) => b.weighted - a.weighted)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface EvalMetrics {
  total:     number
  passed:    number
  failed:    number
  precision: number
  recall:    number
  f1:        number
}

interface PerTypeMetrics {
  type:      string
  total:     number
  detected:  number
  missed:    number
  recall:    number
}

function computeMetrics(
  fixtures: EvalFixture[],
  results:  ReplayResult[],
  filter: 'all' | 'strong' | 'weak' = 'all'
): EvalMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0
  let included = 0

  for (let i = 0; i < fixtures.length; i++) {
    const quality = fixtures[i].label.groundtruth_quality ?? 'strong'
    if (filter === 'strong' && quality !== 'strong') continue
    if (filter === 'weak' && quality !== 'weak') continue

    included++
    const label    = fixtures[i].label.drift
    const detected = results[i].drift_detected

    if (label && detected)  tp++
    if (!label && detected) fp++
    if (label && !detected) fn++
    if (!label && !detected) tn++
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall    = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1        = precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall)

  return {
    total:  included,
    passed: tp + tn,
    failed: fp + fn,
    precision: Math.round(precision * 1000) / 1000,
    recall:    Math.round(recall    * 1000) / 1000,
    f1:        Math.round(f1        * 1000) / 1000,
  }
}

function computePerTypeMetrics(
  fixtures: EvalFixture[],
  results:  ReplayResult[]
): PerTypeMetrics[] {
  const typeMap = new Map<string, { total: number; detected: number }>()

  for (let i = 0; i < fixtures.length; i++) {
    const driftType = fixtures[i].label.drift_type ?? 'none'
    if (!fixtures[i].label.drift) continue

    const entry = typeMap.get(driftType) ?? { total: 0, detected: 0 }
    entry.total++
    if (results[i].drift_detected) entry.detected++
    typeMap.set(driftType, entry)
  }

  const perType: PerTypeMetrics[] = []
  for (const [type, { total, detected }] of typeMap.entries()) {
    perType.push({
      type,
      total,
      detected,
      missed: total - detected,
      recall: Math.round((detected / total) * 1000) / 1000,
    })
  }

  return perType.sort((a, b) => a.type.localeCompare(b.type))
}

// ---------------------------------------------------------------------------
// JSON Report
// ---------------------------------------------------------------------------

interface EvalReport {
  timestamp:    string
  fixture_dir:  string
  total:        number
  metrics:      EvalMetrics
  per_type:     PerTypeMetrics[]
  results:      Array<{
    fixture_id:     string
    description:    string
    drift_type:     string | undefined
    expected_drift: boolean
    detected_drift: boolean
    final_score:    number
    drift_status:   string
    passed:         boolean
    signals:        SignalBreakdown | null
    weighted_contributions: WeightedContribution[]
    dominant_signal: string
  }>
}

function writeReport(report: EvalReport): string {
  const reportsDir = path.join(__dirname, 'reports')
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true })
  }
  const filename = `eval-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`
  const filePath = path.join(reportsDir, filename)
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2))
  return filePath
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const fixtureDirArg = process.argv.find(a => a.startsWith('--fixture-dir='))
  const fixtureDir = fixtureDirArg
    ? fixtureDirArg.split('=')[1]
    : path.join(__dirname, 'fixtures-valid')
  const fixtures   = loadFixtures(fixtureDir)

  if (fixtures.length === 0) {
    console.log('No fixtures found in eval/fixtures/. Add .json files to begin.')
    return
  }

  console.log(`Running eval against ${fixtures.length} fixture(s)...\n`)

  const results: ReplayResult[] = []

  for (const fixture of fixtures) {
    const result = await replayFixture(fixture)
    results.push(result)

    const expected = fixture.label.drift
    const passed   = expected === result.drift_detected
    const status   = passed ? 'PASS' : 'FAIL'

    console.log(
      `${status.padEnd(4)}  ${fixture.id.padEnd(20)}` +
      `  score=${result.final_score.toFixed(2)}` +
      `  detected=${String(result.drift_detected).padEnd(5)}` +
      `  expected=${String(expected).padEnd(5)}` +
      `  status=${result.drift_status}`
    )

    if (!passed) {
      console.log(`      Expected drift=${expected}, got drift=${result.drift_detected}`)
      console.log(`      Label type: ${fixture.label.drift_type ?? 'n/a'}`)
    }

    if (result.narrative.length > 0) {
      console.log(`\n      Narrative:`)
      result.narrative.forEach(s => console.log(`        ${s}`))
      console.log()
    }
  }

  const metricsAll    = computeMetrics(fixtures, results, 'all')
  const metricsStrong = computeMetrics(fixtures, results, 'strong')
  const metricsWeak   = computeMetrics(fixtures, results, 'weak')
  const perType       = computePerTypeMetrics(fixtures, results)

  const strongCount = fixtures.filter(f => (f.label.groundtruth_quality ?? 'strong') === 'strong').length
  const weakCount   = fixtures.length - strongCount

  console.log('\n' + '─'.repeat(60))
  console.log(`Total fixtures: ${fixtures.length}  (strong: ${strongCount}, weak: ${weakCount})`)
  console.log()
  console.log(`  STRONG only (${metricsStrong.total} fixtures):`)
  console.log(`    Results:   ${metricsStrong.passed}/${metricsStrong.total} passed`)
  console.log(`    Precision: ${metricsStrong.precision}`)
  console.log(`    Recall:    ${metricsStrong.recall}`)
  console.log(`    F1:        ${metricsStrong.f1}`)
  console.log()
  console.log(`  WEAK only (${metricsWeak.total} fixtures):`)
  console.log(`    Results:   ${metricsWeak.passed}/${metricsWeak.total} passed`)
  console.log(`    Precision: ${metricsWeak.precision}`)
  console.log(`    Recall:    ${metricsWeak.recall}`)
  console.log(`    F1:        ${metricsWeak.f1}`)
  console.log()
  console.log(`  ALL (${metricsAll.total} fixtures):`)
  console.log(`    Results:   ${metricsAll.passed}/${metricsAll.total} passed`)
  console.log(`    Precision: ${metricsAll.precision}`)
  console.log(`    Recall:    ${metricsAll.recall}`)
  console.log(`    F1:        ${metricsAll.f1}`)
  console.log('─'.repeat(60))

  if (perType.length > 0) {
    console.log('\nPer-type breakdown:')
    for (const pt of perType) {
      console.log(
        `  ${pt.type.padEnd(28)} ${pt.detected}/${pt.total} detected  recall=${pt.recall}`
      )
    }
  }

  // Use strong-only metrics as the primary report metric
  const metrics = metricsStrong

  // Write structured JSON report
  const report: EvalReport = {
    timestamp:   new Date().toISOString(),
    fixture_dir: fixtureDir,
    total:       fixtures.length,
    metrics,
    per_type:    perType,
    results:     fixtures.map((f, i) => ({
      fixture_id:     f.id,
      description:    f.description,
      drift_type:     f.label.drift_type,
      expected_drift: f.label.drift,
      detected_drift: results[i].drift_detected,
      final_score:    results[i].final_score,
      drift_status:   results[i].drift_status,
      passed:         f.label.drift === results[i].drift_detected,
      signals:        results[i].signals,
      weighted_contributions: results[i].weighted_contributions,
      dominant_signal: results[i].dominant_signal,
    })),
  }

  const reportPath = writeReport(report)
  console.log(`\n📄 Report saved: ${reportPath}`)

  // Generate timelines if --timeline flag is set
  if (process.argv.includes('--timeline')) {
    await generateTimelines(fixtures, fixtureDir)
  }

  // -----------------------------------------------------------------------
  // FP Analysis: dump false positives with signal breakdown
  // -----------------------------------------------------------------------
  const fpCases: Array<{ fixture: EvalFixture; result: ReplayResult }> = []
  const fnCases: Array<{ fixture: EvalFixture; result: ReplayResult }> = []

  for (let i = 0; i < fixtures.length; i++) {
    const expected = fixtures[i].label.drift
    const detected = results[i].drift_detected
    if (!expected && detected) fpCases.push({ fixture: fixtures[i], result: results[i] })
    if (expected && !detected) fnCases.push({ fixture: fixtures[i], result: results[i] })
  }

  if (fpCases.length > 0) {
    console.log('\n' + '═'.repeat(60))
    console.log(`FALSE POSITIVES (${fpCases.length} cases) — expected=false, detected=true`)
    console.log('═'.repeat(60))

    // FP by dominant signal
    const fpBySignal = new Map<string, number>()
    for (const fp of fpCases) {
      const sig = fp.result.dominant_signal
      fpBySignal.set(sig, (fpBySignal.get(sig) ?? 0) + 1)
    }
    console.log('\nFP by dominant signal:')
    for (const [sig, count] of [...fpBySignal.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sig.padEnd(28)} ${count} cases`)
    }

    // FP by score band
    const bands = { '0.50-0.55': 0, '0.55-0.60': 0, '0.60-0.70': 0, '0.70-0.80': 0, '0.80+': 0 }
    for (const fp of fpCases) {
      const s = fp.result.final_score
      if (s < 0.55) bands['0.50-0.55']++
      else if (s < 0.60) bands['0.55-0.60']++
      else if (s < 0.70) bands['0.60-0.70']++
      else if (s < 0.80) bands['0.70-0.80']++
      else bands['0.80+']++
    }
    console.log('\nFP by score band:')
    for (const [band, count] of Object.entries(bands)) {
      if (count > 0) console.log(`  ${band.padEnd(28)} ${count} cases`)
    }

    // Per-FP detail
    console.log('\nPer-FP signal breakdown:')
    for (const fp of fpCases) {
      console.log(`\n  ${fp.fixture.id}  score=${fp.result.final_score.toFixed(3)}  dominant=${fp.result.dominant_signal}`)
      console.log(`    desc: ${fp.fixture.description.slice(0, 80)}`)
      if (fp.result.weighted_contributions.length > 0) {
        console.log('    weighted contributions:')
        for (const c of fp.result.weighted_contributions) {
          const bar = '█'.repeat(Math.round(c.weighted * 50))
          console.log(`      ${c.signal.padEnd(26)} raw=${c.raw_value.toFixed(3).padStart(6)}  weighted=${c.weighted.toFixed(3).padStart(6)}  ${bar}`)
        }
      }
    }
  }

  if (fnCases.length > 0) {
    console.log('\n' + '═'.repeat(60))
    console.log(`FALSE NEGATIVES (${fnCases.length} cases) — expected=true, detected=false`)
    console.log('═'.repeat(60))

    // FN by drift type
    const fnByType = new Map<string, number>()
    for (const fn of fnCases) {
      const t = fn.fixture.label.drift_type ?? 'unknown'
      fnByType.set(t, (fnByType.get(t) ?? 0) + 1)
    }
    console.log('\nFN by drift type:')
    for (const [t, count] of [...fnByType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t.padEnd(28)} ${count} cases`)
    }

    // Per-FN detail
    console.log('\nPer-FN signal breakdown:')
    for (const fn of fnCases) {
      console.log(`\n  ${fn.fixture.id}  score=${fn.result.final_score.toFixed(3)}  type=${fn.fixture.label.drift_type ?? 'n/a'}  dominant=${fn.result.dominant_signal}`)
      if (fn.result.weighted_contributions.length > 0) {
        console.log('    weighted contributions:')
        for (const c of fn.result.weighted_contributions) {
          const bar = '█'.repeat(Math.round(c.weighted * 50))
          console.log(`      ${c.signal.padEnd(26)} raw=${c.raw_value.toFixed(3).padStart(6)}  weighted=${c.weighted.toFixed(3).padStart(6)}  ${bar}`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Timeline generation (--timeline flag)
// ---------------------------------------------------------------------------

async function generateTimelines(fixtures: EvalFixture[], fixtureDir: string): Promise<void> {
  const { TimelineBuilder } = await import('../src/timeline/builder')
  const builder = new TimelineBuilder()

  const timelineDir = path.join(__dirname, 'timelines')
  if (!fs.existsSync(timelineDir)) {
    fs.mkdirSync(timelineDir, { recursive: true })
  }

  for (const fixture of fixtures) {
    const events = (fixture.session as any).events as any[] ?? []
    const toolEvents = events.filter((e: any) => e.type === 'tool_call')
    const goalText = fixture.session.goals[0]?.raw ?? ''

    const timeline = builder.build(fixture.session.id, goalText, toolEvents)
    const outPath = path.join(timelineDir, `${fixture.id}.timeline.json`)
    fs.writeFileSync(outPath, JSON.stringify(timeline, null, 2))
  }

  console.log(`\n📊 Timelines generated: ${timelineDir}/ (${fixtures.length} files)`)
}

run().catch(err => {
  console.error('Eval runner error:', err)
  process.exit(1)
})