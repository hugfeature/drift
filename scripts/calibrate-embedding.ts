/**
 * Calibration script: collects raw cosine similarity distribution
 * from eval fixtures using Ollama nomic-embed-text.
 *
 * Outputs: aligned vs unrelated similarity ranges to tune LOW/HIGH thresholds.
 *
 * Run: npx ts-node --transpile-only scripts/calibrate-embedding.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { OllamaEmbeddingProvider } from '../src/embedding/ollama-provider'
import { cosineSimilarity } from '../src/embedding/provider'
import type { EvalFixture } from '../src/types/eval'

interface Sample {
  fixture_id: string
  goal: string
  action: string
  similarity: number
  expected_drift: boolean
  relation: 'aligned' | 'unrelated'  // based on keyword heuristic
}

function extractActionText(event: any): string {
  const parts: string[] = []
  const payload = event.payload ?? {}
  if (payload.tool_name) parts.push(String(payload.tool_name))
  if (payload.target) parts.push(String(payload.target))
  if (payload.message) parts.push(String(payload.message))
  return parts.join(' ') || event.type
}

async function main() {
  const provider = new OllamaEmbeddingProvider()
  const fixtureDir = path.join(__dirname, '..', 'eval', 'fixtures')
  const files = fs.readdirSync(fixtureDir).filter(f => f.endsWith('.json'))

  const samples: Sample[] = []
  let processed = 0

  for (const file of files) {
    const fixture: EvalFixture = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, file), 'utf-8')
    )
    processed++
    process.stderr.write(`\rProcessing ${processed}/${files.length}: ${fixture.id}`)

    const goal = fixture.session.goals[0]
    if (!goal) continue

    const goalText = goal.normalized
      ? [...goal.normalized.observable_targets, ...goal.normalized.allowed_domains].join(' ')
      : goal.raw

    const goalVector = await provider.embed(goalText)

    const events = (fixture.session as any).events as any[] ?? []
    const toolCalls = events.filter((e: any) => e.type === 'tool_call').slice(0, 10) // sample first 10

    for (const evt of toolCalls) {
      const actionText = extractActionText(evt)
      const actionVector = await provider.embed(actionText)
      const sim = cosineSimilarity(goalVector, actionVector)

      // Simple heuristic: if goal keywords appear in action, it's "aligned"
      const goalWords = goalText.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      const actionLower = actionText.toLowerCase()
      const hasOverlap = goalWords.some(w => actionLower.includes(w))

      samples.push({
        fixture_id: fixture.id,
        goal: goalText.slice(0, 80),
        action: actionText.slice(0, 80),
        similarity: sim,
        expected_drift: fixture.label?.drift ?? false,
        relation: hasOverlap ? 'aligned' : 'unrelated',
      })
    }
  }

  console.error('\n\nDone collecting samples.\n')

  // Analyze distribution
  const aligned = samples.filter(s => s.relation === 'aligned').map(s => s.similarity)
  const unrelated = samples.filter(s => s.relation === 'unrelated').map(s => s.similarity)

  const stats = (arr: number[]) => {
    if (arr.length === 0) return { count: 0, min: 0, max: 0, mean: 0, p25: 0, p50: 0, p75: 0 }
    const sorted = [...arr].sort((a, b) => a - b)
    return {
      count: arr.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: arr.reduce((s, v) => s + v, 0) / arr.length,
      p25: sorted[Math.floor(sorted.length * 0.25)],
      p50: sorted[Math.floor(sorted.length * 0.50)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
    }
  }

  const alignedStats = stats(aligned)
  const unrelatedStats = stats(unrelated)

  console.log('=== Cosine Similarity Distribution ===\n')
  console.log(`Total samples: ${samples.length}`)
  console.log()
  console.log('ALIGNED actions (goal keywords found in action):')
  console.log(`  Count: ${alignedStats.count}`)
  console.log(`  Min:   ${alignedStats.min.toFixed(4)}`)
  console.log(`  P25:   ${alignedStats.p25.toFixed(4)}`)
  console.log(`  P50:   ${alignedStats.p50.toFixed(4)}`)
  console.log(`  P75:   ${alignedStats.p75.toFixed(4)}`)
  console.log(`  Max:   ${alignedStats.max.toFixed(4)}`)
  console.log(`  Mean:  ${alignedStats.mean.toFixed(4)}`)
  console.log()
  console.log('UNRELATED actions (no goal keywords in action):')
  console.log(`  Count: ${unrelatedStats.count}`)
  console.log(`  Min:   ${unrelatedStats.min.toFixed(4)}`)
  console.log(`  P25:   ${unrelatedStats.p25.toFixed(4)}`)
  console.log(`  P50:   ${unrelatedStats.p50.toFixed(4)}`)
  console.log(`  P75:   ${unrelatedStats.p75.toFixed(4)}`)
  console.log(`  Max:   ${unrelatedStats.max.toFixed(4)}`)
  console.log(`  Mean:  ${unrelatedStats.mean.toFixed(4)}`)
  console.log()

  // Suggest thresholds
  // LOW = point where aligned actions start (below = clearly aligned → divergence 0)
  // HIGH = point where unrelated actions dominate (above = clearly unrelated → divergence 1)
  // In divergence terms: LOW_DIV = 1 - aligned_p75, HIGH_DIV = 1 - unrelated_p25
  const suggestedLow = 1 - alignedStats.p75
  const suggestedHigh = 1 - unrelatedStats.p25

  console.log('=== Suggested Calibration ===')
  console.log(`  Current: LOW=0.25, HIGH=0.65`)
  console.log(`  Suggested LOW  (1 - aligned P75 similarity):   ${suggestedLow.toFixed(4)}`)
  console.log(`  Suggested HIGH (1 - unrelated P25 similarity): ${suggestedHigh.toFixed(4)}`)
  console.log()

  // Also show overlap zone
  console.log('=== Overlap Analysis ===')
  console.log(`  Aligned similarity range:   [${alignedStats.min.toFixed(3)}, ${alignedStats.max.toFixed(3)}]`)
  console.log(`  Unrelated similarity range: [${unrelatedStats.min.toFixed(3)}, ${unrelatedStats.max.toFixed(3)}]`)
  console.log(`  Overlap: [${Math.max(unrelatedStats.min, alignedStats.min).toFixed(3)}, ${Math.min(unrelatedStats.max, alignedStats.max).toFixed(3)}]`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
