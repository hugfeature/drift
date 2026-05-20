/**
 * Package an anonymized session as a contribution-ready fixture.
 *
 * Adds a label template for human annotation and validates structure.
 *
 * Usage:
 *   npx ts-node scripts/contribute.ts <anonymized.json> [--drift] [--no-drift]
 *
 * Workflow:
 *   1. Record session via Claude Code hook (automatic)
 *   2. npx ts-node scripts/anonymize-session.ts raw-session.json
 *   3. npx ts-node scripts/contribute.ts raw-session_anonymized.json --drift
 *   4. Fill in the annotation fields in the output
 *   5. PR to eval/fixtures/
 */

import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DriftLabel {
  session_id: string
  drift: boolean
  drift_type?: 'scope_expansion' | 'goal_forgotten' | 'unauthorized_mutation' | 'rabbit_hole' | 'cleanup_spiral'
  drift_started_at?: number
  goal_forgotten_at?: number
  takeover_required: boolean
  annotator_notes: string
  annotated_by: 'human'
  known_scorer_limitation?: boolean
}

interface ContributeOptions {
  isDrift: boolean | null
  outputDir: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSession(data: any): string[] {
  const errors: string[] = []

  if (!data.session) errors.push('Missing "session" field')
  if (!data.session?.events?.length) errors.push('No events in session')
  if (!data.session?.goals?.length) errors.push('No goals in session')
  if (!data.session?.started_at && data.session?.started_at !== 0) {
    errors.push('Missing session.started_at')
  }

  const events = data.session?.events || []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!e.id) errors.push(`Event ${i}: missing id`)
    if (!e.timestamp && e.timestamp !== 0) errors.push(`Event ${i}: missing timestamp`)
    if (!e.type) errors.push(`Event ${i}: missing type`)
  }

  return errors
}

// ---------------------------------------------------------------------------
// Label generation
// ---------------------------------------------------------------------------

function inferDriftTimestamps(events: any[]): { driftStartedAt: number; goalForgottenAt: number } {
  // Find first event marked as 'expansion' or 'unrelated' — likely drift onset
  const firstExpansion = events.find(
    (e: any) => e.goal_relation === 'expansion' || e.goal_relation === 'unrelated'
  )
  // Find first event marked 'unrelated' specifically — likely goal forgotten
  const firstUnrelated = events.find((e: any) => e.goal_relation === 'unrelated')

  // If no relation labels exist, estimate from drift_score_at_event
  // Use the first event where score exceeds 0.5 (drifting threshold)
  const firstHighScore = events.find((e: any) => (e.drift_score_at_event ?? 0) >= 0.5)

  const driftStartedAt = firstExpansion?.timestamp
    ?? firstHighScore?.timestamp
    ?? (events.length > 2 ? events[Math.floor(events.length * 0.3)].timestamp : events[0]?.timestamp ?? 0)

  const goalForgottenAt = firstUnrelated?.timestamp
    ?? (firstHighScore ? events[Math.min(events.indexOf(firstHighScore) + 2, events.length - 1)].timestamp : undefined)
    ?? (events.length > 4 ? events[Math.floor(events.length * 0.5)].timestamp : driftStartedAt)

  return { driftStartedAt, goalForgottenAt }
}

function generateDescription(data: any): string {
  const events = data.session?.events || []
  const goal = data.session?.goals?.[0]?.raw || 'unknown goal'
  const eventCount = events.length
  const durationMinutes = events.length > 1
    ? Math.round((events[events.length - 1].timestamp - events[0].timestamp) / 60000)
    : 0
  const agent = data.session?.agent || data.agent || 'unknown'
  const toolNames = [...new Set(events.map((e: any) => e.payload?.tool_name).filter(Boolean))]

  return `${agent} session: "${goal}" — ${eventCount} events over ~${durationMinutes}min using ${toolNames.slice(0, 5).join(', ')}`
}

function generateLabel(data: any, isDrift: boolean | null): DriftLabel {
  const sessionId = data.session?.id || `sess_${Date.now().toString(36)}`
  const events = data.session?.events || []
  const durationMinutes = events.length > 0
    ? Math.round((events[events.length - 1].timestamp - events[0].timestamp) / 60000)
    : 0
  const goal = data.session?.goals?.[0]?.raw || 'unknown'

  const baseLabel: DriftLabel = {
    session_id: sessionId,
    drift: isDrift ?? false,
    takeover_required: false,
    annotator_notes: `${events.length} events over ~${durationMinutes} minutes. Goal: "${goal}". [ANNOTATE: describe what happened and whether actions stayed aligned]`,
    annotated_by: 'human',
  }

  if (isDrift === true) {
    const { driftStartedAt, goalForgottenAt } = inferDriftTimestamps(events)
    baseLabel.drift_type = 'scope_expansion'
    baseLabel.drift_started_at = driftStartedAt
    baseLabel.goal_forgotten_at = goalForgottenAt
    baseLabel.takeover_required = true
    baseLabel.annotator_notes = `${events.length} events over ~${durationMinutes}min. Goal: "${goal}". Drift inferred at T+${Math.round((driftStartedAt - (events[0]?.timestamp ?? 0)) / 60000)}m. [ANNOTATE: verify drift_started_at/goal_forgotten_at timestamps, describe what unauthorized action triggered drift, confirm if original goal was ever completed]`
  } else if (isDrift === false) {
    baseLabel.annotator_notes = `${events.length} events over ~${durationMinutes}min. Goal: "${goal}". All actions appear aligned. [ANNOTATE: confirm alignment, note any valid refinements or known scorer edge cases]`
  } else {
    baseLabel.annotator_notes = `${events.length} events over ~${durationMinutes}min. Goal: "${goal}". [ANNOTATE: re-run with --drift or --no-drift flag, then complete annotation]`
  }

  return baseLabel
}

// ---------------------------------------------------------------------------
// Fixture packaging
// ---------------------------------------------------------------------------

function packageFixture(data: any, label: DriftLabel): any {
  // Generate fixture ID based on existing fixtures count
  const fixturesDir = path.resolve(__dirname, '../eval/fixtures')
  const existingFixtures = fs.existsSync(fixturesDir)
    ? fs.readdirSync(fixturesDir).filter(f => f.startsWith('case_') && f.endsWith('.json'))
    : []
  const nextNum = existingFixtures.length + 1
  const fixtureId = `fixture_${String(nextNum).padStart(3, '0')}`

  const fixture = {
    id: fixtureId,
    description: generateDescription(data),
    agent: data.session?.agent || data.agent || 'unknown',
    created_at: Date.now(),
    source: 'community_contribution',
    session: data.session,
    label,
  }

  return { fixture, fixtureId, nextNum }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: npx ts-node scripts/contribute.ts <session.json> [flags]

Flags:
  --drift      Mark this session as containing drift (positive case)
  --no-drift   Mark this session as aligned (negative case)
  --dir <path> Output directory (default: eval/fixtures)

Drift types (fill in the output JSON):
  scope_expansion       — agent added work beyond original scope
  goal_forgotten        — agent stopped working on original goal entirely
  unauthorized_mutation — agent changed files/configs without permission
  rabbit_hole           — agent went deep into debugging unrelated issues
  cleanup_spiral        — agent started "cleaning up" unprompted

Example:
  npx ts-node scripts/anonymize-session.ts my-session.json
  npx ts-node scripts/contribute.ts my-session_anonymized.json --drift
  # Review the output, refine annotator_notes
  # git add eval/fixtures/case_NNN.json && git commit
`)
    process.exit(0)
  }

  const inputFile = path.resolve(args.find(a => !a.startsWith('--')) || '')
  const isDrift = args.includes('--drift') ? true : args.includes('--no-drift') ? false : null

  const dirIdx = args.indexOf('--dir')
  const outputDir = dirIdx >= 0 && args[dirIdx + 1]
    ? path.resolve(args[dirIdx + 1])
    : path.resolve(__dirname, '../eval/fixtures')

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: File not found: ${inputFile}`)
    process.exit(1)
  }

  const raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'))

  // Validate
  const errors = validateSession(raw)
  if (errors.length > 0) {
    console.error('\n❌ Validation errors:')
    errors.forEach(e => console.error(`   • ${e}`))
    console.error('\nFix these before contributing.')
    process.exit(1)
  }

  // Generate label
  const label = generateLabel(raw, isDrift)

  // Package
  const { fixture, fixtureId, nextNum } = packageFixture(raw, label)
  const outputFile = path.join(outputDir, `case_${String(nextNum).padStart(3, '0')}.json`)

  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(outputFile, JSON.stringify(fixture, null, 2))

  const goalText = raw.session?.goals?.[0]?.raw || 'unknown'
  const eventCount = raw.session?.events?.length || 0

  console.log(`
✓ Fixture created: ${outputFile}

  ID:     ${fixtureId}
  Goal:   "${goalText}"
  Events: ${eventCount}
  Drift:  ${isDrift === null ? '⚠️  UNMARKED (use --drift or --no-drift)' : isDrift ? '🔴 YES' : '🟢 NO'}

Next steps:
  1. Open ${outputFile}
  2. Review and refine "label.annotator_notes"${isDrift ? '\n  3. Verify "drift_started_at" and "goal_forgotten_at" timestamps are correct' : ''}${isDrift === null ? '\n  3. Re-run with --drift or --no-drift flag' : ''}
  4. PR to eval/fixtures/
`)
}

main()
