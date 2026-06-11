/**
 * Batch score all fixtures and output confusion matrix.
 *
 * Runs the DriftScorer against each fixture's events,
 * compares predicted drift (score >= threshold) vs human label,
 * and outputs precision/recall/F1 + per-type breakdown.
 *
 * Usage:
 *   npx ts-node scripts/batch-score.ts [--threshold 0.45] [--verbose]
 */

import * as fs from 'fs'
import * as path from 'path'
import { DriftScorer } from '../src/scoring/scorer'
import { GoalStore } from '../src/goal/store'
import { createEmbeddingProvider } from '../src/embedding/nomic-adapter'
import type { EmbeddingProvider } from '../src/embedding/provider'
import type { RuntimeEvent } from '../src/types/event'

interface FixtureData {
  id: string
  session: {
    id: string
    goals: Array<{ id: string; raw: string; status: string }>
    events: RuntimeEvent[]
    active_goal_id?: string
  }
  label: {
    drift: boolean
    drift_type?: string
    takeover_required?: boolean
    annotator_notes?: string
  }
}

interface ScoredResult {
  caseId: string
  humanDrift: boolean
  humanType: string
  predictedScore: number
  predictedDrift: boolean
  predictedStatus: string
  correct: boolean
}

function loadFixtures(): FixtureData[] {
  const dir = path.join(process.cwd(), 'eval', 'fixtures')
  const files = fs.readdirSync(dir)
    .filter(f => f.match(/^case_\d+\.json$/))
    .sort()

  const fixtures: FixtureData[] = []
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      if (data.label && data.session?.events) {
        fixtures.push(data)
      }
    } catch { /* skip malformed */ }
  }
  return fixtures
}

async function scoreFixture(
  fixture: FixtureData,
  embeddingProvider?: EmbeddingProvider
): Promise<ScoredResult> {
  const sessionId = fixture.session.id || 'unknown'
  const store = new GoalStore(sessionId)

  // Create goal from fixture's goals array or infer from first user prompt
  const goals = fixture.session.goals || []
  if (goals.length > 0) {
    const mainGoal = goals[0]
    store.create(mainGoal.raw, fixture.session.events[0]?.timestamp || Date.now())
  } else {
    // Infer goal from first event or use placeholder
    const firstEvent = fixture.session.events[0]
    const goalText = (firstEvent?.payload?.['message'] as string) || 'unknown task'
    store.create(goalText, firstEvent?.timestamp || Date.now())
  }

  const scorer = new DriftScorer(store, embeddingProvider)
  const events = fixture.session.events as RuntimeEvent[]

  // Score using full event stream so autonomy_momentum sees all user interactions
  let lastScore = 0
  let lastStatus = 'aligned'

  try {
    const result = await scorer.score(events)
    lastScore = result.score
    lastStatus = result.status
  } catch {
    // Fallback: try last 50 events
    try {
      const result = await scorer.score(events.slice(-50))
      lastScore = result.score
      lastStatus = result.status
    } catch { /* keep defaults */ }
  }

  const humanDrift = fixture.label.drift
  const humanType = fixture.label.drift_type || 'none'

  return {
    caseId: fixture.id,
    humanDrift,
    humanType,
    predictedScore: lastScore,
    predictedDrift: lastStatus !== 'aligned',
    predictedStatus: lastStatus,
    correct: humanDrift === (lastStatus !== 'aligned'),
  }
}

function printConfusionMatrix(results: ScoredResult[], threshold: number): void {
  // Re-classify with threshold
  for (const r of results) {
    r.predictedDrift = r.predictedScore >= threshold
    r.correct = r.humanDrift === r.predictedDrift
  }

  const tp = results.filter(r => r.humanDrift && r.predictedDrift).length
  const fp = results.filter(r => !r.humanDrift && r.predictedDrift).length
  const tn = results.filter(r => !r.humanDrift && !r.predictedDrift).length
  const fn = results.filter(r => r.humanDrift && !r.predictedDrift).length

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0
  const accuracy = (tp + tn) / results.length

  console.log('\n=== CONFUSION MATRIX (threshold=' + threshold.toFixed(2) + ') ===\n')
  console.log('                 Predicted')
  console.log('                 Drift    No-Drift')
  console.log('  Actual Drift   ' + pad(String(tp), 8) + pad(String(fn), 8) + '  (total: ' + (tp + fn) + ')')
  console.log('  Actual Normal  ' + pad(String(fp), 8) + pad(String(tn), 8) + '  (total: ' + (fp + tn) + ')')
  console.log()
  console.log('  Precision: ' + precision.toFixed(3) + '  (of predicted drift, how many are real)')
  console.log('  Recall:    ' + recall.toFixed(3) + '  (of actual drift, how many were caught)')
  console.log('  F1:        ' + f1.toFixed(3))
  console.log('  Accuracy:  ' + accuracy.toFixed(3))

  // Per-type breakdown
  const types = new Set(results.filter(r => r.humanDrift).map(r => r.humanType))
  if (types.size > 0) {
    console.log('\n=== PER-TYPE RECALL ===\n')
    for (const dtype of types) {
      const typeResults = results.filter(r => r.humanType === dtype)
      const caught = typeResults.filter(r => r.predictedDrift).length
      console.log('  ' + pad(dtype, 25) + caught + '/' + typeResults.length + ' (' + (caught / typeResults.length * 100).toFixed(0) + '%)')
    }
  }

  // False positives detail
  const falsePositives = results.filter(r => !r.humanDrift && r.predictedDrift)
  if (falsePositives.length > 0) {
    console.log('\n=== FALSE POSITIVES (' + falsePositives.length + ') ===\n')
    for (const r of falsePositives) {
      console.log('  ' + r.caseId + ' score=' + r.predictedScore.toFixed(3))
    }
  }

  // False negatives detail
  const falseNegatives = results.filter(r => r.humanDrift && !r.predictedDrift)
  if (falseNegatives.length > 0) {
    console.log('\n=== FALSE NEGATIVES (' + falseNegatives.length + ') ===\n')
    for (const r of falseNegatives) {
      console.log('  ' + r.caseId + ' type=' + r.humanType + ' score=' + r.predictedScore.toFixed(3))
    }
  }
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}

async function main() {
  const args = process.argv.slice(2)
  const thresholdIdx = args.indexOf('--threshold')
  const threshold = thresholdIdx >= 0 ? parseFloat(args[thresholdIdx + 1] || '0.45') : 0.45
  const verbose = args.includes('--verbose')
  const embeddingIdx = args.indexOf('--embedding')
  const embeddingType = embeddingIdx >= 0 ? args[embeddingIdx + 1] : 'keyword'

  // Initialize embedding provider
  let embeddingProvider: EmbeddingProvider | undefined
  if (embeddingType && embeddingType !== 'keyword') {
    console.log(`Initializing ${embeddingType} embedding provider...`)
    embeddingProvider = await createEmbeddingProvider({ provider: embeddingType as 'nomic' | 'openai' })
    console.log('  Embedding provider ready\n')
  }

  console.log('Loading fixtures...')
  const fixtures = loadFixtures()
  console.log('  Found ' + fixtures.length + ' labeled fixtures\n')

  console.log('Scoring...\n')
  const results: ScoredResult[] = []

  for (const fixture of fixtures) {
    const result = await scoreFixture(fixture, embeddingProvider)
    results.push(result)

    if (verbose) {
      const mark = result.correct ? '+' : 'X'
      const label = result.humanDrift ? 'DRIFT:' + result.humanType : 'clean'
      console.log(
        '  [' + mark + '] ' + pad(fixture.id, 20) +
        'score=' + pad(result.predictedScore.toFixed(3), 8) +
        'pred=' + pad(result.predictedStatus, 10) +
        'label=' + label
      )
    }
  }

  printConfusionMatrix(results, threshold)

  // Try multiple thresholds
  console.log('\n=== THRESHOLD SENSITIVITY ===\n')
  console.log(pad('Threshold', 12) + pad('Prec', 8) + pad('Recall', 8) + pad('F1', 8) + 'Accuracy')
  for (const t of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
    const tp = results.filter(r => r.humanDrift && r.predictedScore >= t).length
    const fp = results.filter(r => !r.humanDrift && r.predictedScore >= t).length
    const fn = results.filter(r => r.humanDrift && r.predictedScore < t).length
    const tn = results.filter(r => !r.humanDrift && r.predictedScore < t).length
    const p = tp + fp > 0 ? tp / (tp + fp) : 0
    const r = tp + fn > 0 ? tp / (tp + fn) : 0
    const f1 = p + r > 0 ? 2 * p * r / (p + r) : 0
    const acc = (tp + tn) / results.length
    console.log(pad(t.toFixed(2), 12) + pad(p.toFixed(3), 8) + pad(r.toFixed(3), 8) + pad(f1.toFixed(3), 8) + acc.toFixed(3))
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
