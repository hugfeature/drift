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
    precision: Math.round(precision * 100) / 100,
    recall:    Math.round(recall    * 100) / 100,
    f1:        Math.round(f1        * 100) / 100,
  }
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

  console.log('\n' + '─'.repeat(60))
  console.log(`Results:   ${metrics.passed}/${metrics.total} passed`)
  console.log(`Precision: ${metrics.precision}`)
  console.log(`Recall:    ${metrics.recall}`)
  console.log(`F1:        ${metrics.f1}`)
  console.log('─'.repeat(60))
}

run().catch(err => {
  console.error('Eval runner error:', err)
  process.exit(1)
})