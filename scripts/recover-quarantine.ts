/**
 * Recover quarantined fixtures by inferring goals from tool call patterns.
 *
 * Strategy:
 *   1. Extract first 5 tool targets and messages to infer session intent
 *   2. Generate a candidate goal text from the inferred context
 *   3. Output recovery report for human review
 *   4. With --apply flag, move confirmed cases to fixtures-valid/
 *
 * Usage:
 *   npx ts-node scripts/recover-quarantine.ts              # report only
 *   npx ts-node scripts/recover-quarantine.ts --apply      # apply recoveries
 */

import * as fs from 'fs'
import * as path from 'path'

interface RecoveryCandidate {
  filename: string
  originalGoal: string
  inferredGoal: string
  confidence: 'high' | 'medium' | 'low'
  drift: boolean
  driftType: string
  eventCount: number
  evidence: string[]
}

function inferGoalFromEvents(events: any[]): { goal: string; confidence: 'high' | 'medium' | 'low'; evidence: string[] } {
  const toolEvents = events.filter((e: any) => e.type === 'tool_call')
  const evidence: string[] = []

  // Extract targets from first 10 tool calls
  const earlyTargets = toolEvents.slice(0, 10)
    .map((e: any) => e.payload?.target || '')
    .filter((t: string) => t && !t.includes('MEMORY'))
    .map((t: string) => t.split('/').slice(-3).join('/'))

  // Extract messages from first 5 tool calls
  const earlyMessages = toolEvents.slice(0, 5)
    .map((e: any) => e.payload?.message || '')
    .filter((m: string) => m.length > 5)
    .map((m: string) => m.slice(0, 60))

  // Extract tool_input commands/queries
  const earlyCommands = toolEvents.slice(0, 10)
    .map((e: any) => {
      const ti = e.payload?.tool_input
      if (ti?.command) return ti.command.slice(0, 60)
      if (ti?.query) return ti.query.slice(0, 60)
      return ''
    })
    .filter((c: string) => c.length > 5)

  // Find dominant project from targets
  const projectHints = earlyTargets
    .map(t => t.split('/')[0])
    .filter(p => p && p !== '.' && p.length > 2)
  const projectCounter = new Map<string, number>()
  for (const p of projectHints) {
    projectCounter.set(p, (projectCounter.get(p) ?? 0) + 1)
  }
  const dominantProject = [...projectCounter.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

  // Infer goal
  let goal = ''
  let confidence: 'high' | 'medium' | 'low' = 'low'

  if (earlyMessages.length >= 2) {
    // Messages give strongest signal
    goal = `[inferred] ${earlyMessages[0]}`
    evidence.push(`First action message: "${earlyMessages[0]}"`)
    if (earlyMessages[1]) evidence.push(`Second action: "${earlyMessages[1]}"`)
    confidence = 'medium'
  } else if (earlyTargets.length >= 3) {
    // Targets give project context
    goal = `[inferred] Working on ${dominantProject || earlyTargets[0]}`
    evidence.push(`Dominant target: ${earlyTargets.slice(0, 3).join(', ')}`)
    confidence = 'medium'
  } else if (earlyCommands.length >= 2) {
    goal = `[inferred] ${earlyCommands[0]}`
    evidence.push(`First command: ${earlyCommands[0]}`)
    confidence = 'low'
  } else {
    goal = '[unrecoverable] Insufficient context to infer goal'
    confidence = 'low'
  }

  // Boost confidence if we see clear project focus
  if (dominantProject && earlyTargets.length >= 5) {
    confidence = 'high'
    evidence.push(`Strong project focus: ${dominantProject} (${projectCounter.get(dominantProject)} of first 10 targets)`)
  }

  return { goal, confidence, evidence }
}

function main() {
  const quarantineDir = path.join(__dirname, '..', 'eval', 'quarantine', 'non-evaluable')
  const files = fs.readdirSync(quarantineDir).filter(f => f.endsWith('.json')).sort()

  const candidates: RecoveryCandidate[] = []

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(quarantineDir, file), 'utf-8'))
    const goals = data.session?.goals ?? []
    const goalText = goals[0]?.raw ?? ''
    const events = data.session?.events ?? []
    const toolEvents = events.filter((e: any) => e.type === 'tool_call')

    // Skip cases with too few events
    if (toolEvents.length < 15) continue

    // Skip cases where goal is already clear (shouldn't be in quarantine)
    if (goalText && !goalText.startsWith('[Request interrupted') && goalText !== 'unknown goal') continue

    const { goal, confidence, evidence } = inferGoalFromEvents(events)

    candidates.push({
      filename: file,
      originalGoal: goalText.slice(0, 60),
      inferredGoal: goal,
      confidence,
      drift: data.label?.drift ?? false,
      driftType: data.label?.drift_type ?? 'none',
      eventCount: toolEvents.length,
      evidence,
    })
  }

  // Report
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('QUARANTINE RECOVERY ANALYSIS')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`Total quarantined: ${files.length}`)
  console.log(`Analyzable (≥15 events): ${candidates.length}`)
  console.log()

  const byConfidence = { high: 0, medium: 0, low: 0 }
  for (const c of candidates) byConfidence[c.confidence]++

  console.log(`By confidence:  high=${byConfidence.high}  medium=${byConfidence.medium}  low=${byConfidence.low}`)
  console.log()

  // Show high + medium confidence candidates
  const recoverable = candidates.filter(c => c.confidence !== 'low')
  console.log(`─── Recoverable (high/medium confidence): ${recoverable.length} ───`)
  console.log()

  for (const c of recoverable) {
    const marker = c.confidence === 'high' ? '★' : '○'
    console.log(`${marker} ${c.filename.padEnd(18)} drift=${String(c.drift).padEnd(5)} type=${c.driftType.padEnd(18)} events=${c.eventCount}`)
    console.log(`  Inferred: ${c.inferredGoal}`)
    for (const e of c.evidence) {
      console.log(`  Evidence: ${e}`)
    }
    console.log()
  }

  // Summary
  console.log('─── Summary ───')
  console.log(`Immediately recoverable (high): ${byConfidence.high}`)
  console.log(`Needs review (medium): ${byConfidence.medium}`)
  console.log(`Unrecoverable (low): ${byConfidence.low}`)
  console.log()
  console.log('To recover: review inferred goals above, then manually update')
  console.log('session.goals[0].raw in each fixture and move to fixtures-valid/')
}

main()
