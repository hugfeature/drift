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

interface ReplayResult {
  fixture_id:     string
  final_score:    number
  drift_detected: boolean
  drift_status:   string
  takeover_rec:   boolean
  narrative:      string[]
}

async function replayFixture(fixture: EvalFixture): Promise<ReplayResult> {
  const session = new SessionManager({
    agent:      fixture.agent,
    session_id: fixture.session.id,
    started_at: fixture.session.started_at,
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

  return {
    fixture_id:     fixture.id,
    final_score:    finalScore,
    drift_detected: driftDetected,
    drift_status:   lastResult?.drift_score.status ?? 'aligned',
    takeover_rec:   takeoverRec,
    narrative,
  }
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
  results:  ReplayResult[]
): EvalMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0

  for (let i = 0; i < fixtures.length; i++) {
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
    total:  fixtures.length,
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
  const fixtureDir = path.join(__dirname, 'fixtures')
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

  const metrics = computeMetrics(fixtures, results)
  const perType = computePerTypeMetrics(fixtures, results)

  console.log('\n' + '─'.repeat(60))
  console.log(`Results:   ${metrics.passed}/${metrics.total} passed`)
  console.log(`Precision: ${metrics.precision}`)
  console.log(`Recall:    ${metrics.recall}`)
  console.log(`F1:        ${metrics.f1}`)
  console.log('─'.repeat(60))

  if (perType.length > 0) {
    console.log('\nPer-type breakdown:')
    for (const pt of perType) {
      console.log(
        `  ${pt.type.padEnd(28)} ${pt.detected}/${pt.total} detected  recall=${pt.recall}`
      )
    }
  }

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
    })),
  }

  const reportPath = writeReport(report)
  console.log(`\n📄 Report saved: ${reportPath}`)
}

run().catch(err => {
  console.error('Eval runner error:', err)
  process.exit(1)
})