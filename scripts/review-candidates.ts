/**
 * Review auto-collected candidate fixtures.
 *
 * Lists candidates in eval/candidates/, lets you approve (move to fixtures-valid/)
 * or reject (delete) them.
 *
 * Usage:
 *   npx ts-node scripts/review-candidates.ts              # list all candidates
 *   npx ts-node scripts/review-candidates.ts --approve <id>   # approve → fixtures-valid/
 *   npx ts-node scripts/review-candidates.ts --reject <id>    # delete candidate
 *   npx ts-node scripts/review-candidates.ts --approve-all    # approve all high-confidence
 */

import * as fs from 'fs'
import * as path from 'path'

const CANDIDATES_DIR = path.resolve(__dirname, '../eval/candidates')
const FIXTURES_DIR = path.resolve(__dirname, '../eval/fixtures-valid')

interface CandidateFile {
  filename: string
  id: string
  goal: string
  drift: boolean
  confidence: string
  score: number
  eventCount: number
  createdAt: string
}

function listCandidates(): CandidateFile[] {
  if (!fs.existsSync(CANDIDATES_DIR)) {
    console.log('No candidates directory found. Sessions will appear here after hook collects them.')
    return []
  }

  const files = fs.readdirSync(CANDIDATES_DIR)
    .filter(f => f.startsWith('candidate_') && f.endsWith('.json'))
    .sort()

  return files.map(filename => {
    const data = JSON.parse(fs.readFileSync(path.join(CANDIDATES_DIR, filename), 'utf-8'))
    return {
      filename,
      id: data.id,
      goal: data.session?.goals?.[0]?.raw ?? 'unknown',
      drift: data.auto_label?.drift ?? false,
      confidence: data.auto_label?.confidence ?? 'unknown',
      score: data.auto_label?.final_score ?? 0,
      eventCount: data.session?.events?.length ?? 0,
      createdAt: new Date(data.created_at).toISOString().slice(0, 16),
    }
  })
}

function approveCandidate(candidateId: string): void {
  const files = fs.readdirSync(CANDIDATES_DIR).filter(f => f.includes(candidateId))
  if (files.length === 0) {
    console.error(`❌ No candidate found matching: ${candidateId}`)
    process.exit(1)
  }

  const filename = files[0]
  const sourcePath = path.join(CANDIDATES_DIR, filename)
  const data = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'))

  // Assign a proper case_NNN ID for the fixtures-valid directory
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  const existing = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.startsWith('case_') && f.endsWith('.json'))
  const nextNum = existing.length + 1
  const caseId = `case_${String(nextNum).padStart(3, '0')}`

  // Transform auto_label into proper label format
  const fixture = {
    ...data,
    id: `fixture_${String(nextNum).padStart(3, '0')}`,
    source: 'auto_collected_approved',
    label: {
      session_id: data.session?.id ?? data.id,
      drift: data.auto_label.drift,
      drift_type: data.auto_label.drift ? 'scope_expansion' : undefined,
      takeover_required: data.auto_label.drift,
      annotator_notes: `Auto-collected (score=${data.auto_label.final_score.toFixed(3)}, confidence=${data.auto_label.confidence}). Approved via review-candidates.`,
      annotated_by: 'human' as const,
    },
  }
  delete fixture.auto_label
  delete fixture.needs_review

  const destPath = path.join(FIXTURES_DIR, `${caseId}.json`)
  fs.writeFileSync(destPath, JSON.stringify(fixture, null, 2))
  fs.unlinkSync(sourcePath)

  console.log(`✅ Approved: ${filename} → ${caseId}.json`)
  console.log(`   Goal: "${data.session?.goals?.[0]?.raw?.slice(0, 60)}"`)
  console.log(`   Label: ${data.auto_label.drift ? 'DRIFT' : 'ALIGNED'} (score=${data.auto_label.final_score.toFixed(3)})`)
}

function rejectCandidate(candidateId: string): void {
  const files = fs.readdirSync(CANDIDATES_DIR).filter(f => f.includes(candidateId))
  if (files.length === 0) {
    console.error(`❌ No candidate found matching: ${candidateId}`)
    process.exit(1)
  }

  const filename = files[0]
  fs.unlinkSync(path.join(CANDIDATES_DIR, filename))
  console.log(`🗑️  Rejected and deleted: ${filename}`)
}

function approveAllHighConfidence(): void {
  const candidates = listCandidates().filter(c => c.confidence === 'high')
  if (candidates.length === 0) {
    console.log('No high-confidence candidates to approve.')
    return
  }

  console.log(`Approving ${candidates.length} high-confidence candidates...\n`)
  for (const candidate of candidates) {
    approveCandidate(candidate.id)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  npx ts-node scripts/review-candidates.ts                    # list candidates
  npx ts-node scripts/review-candidates.ts --approve <id>     # approve one
  npx ts-node scripts/review-candidates.ts --reject <id>      # reject one
  npx ts-node scripts/review-candidates.ts --approve-all      # approve all high-confidence
`)
    return
  }

  if (args.includes('--approve-all')) {
    approveAllHighConfidence()
    return
  }

  const approveIdx = args.indexOf('--approve')
  if (approveIdx >= 0) {
    const id = args[approveIdx + 1]
    if (!id) { console.error('Missing candidate ID'); process.exit(1) }
    approveCandidate(id)
    return
  }

  const rejectIdx = args.indexOf('--reject')
  if (rejectIdx >= 0) {
    const id = args[rejectIdx + 1]
    if (!id) { console.error('Missing candidate ID'); process.exit(1) }
    rejectCandidate(id)
    return
  }

  // Default: list candidates
  const candidates = listCandidates()
  if (candidates.length === 0) return

  console.log(`\n📋 ${candidates.length} candidate fixture(s) pending review:\n`)
  console.log('  ID                          | Label   | Conf   | Score | Events | Goal')
  console.log('  ----------------------------|---------|--------|-------|--------|------')

  for (const c of candidates) {
    const label = c.drift ? 'DRIFT' : 'ALIGNED'
    const goalPreview = c.goal.slice(0, 40) + (c.goal.length > 40 ? '...' : '')
    console.log(
      `  ${c.id.padEnd(28)} | ${label.padEnd(7)} | ${c.confidence.padEnd(6)} | ${c.score.toFixed(2).padStart(5)} | ${String(c.eventCount).padStart(6)} | ${goalPreview}`
    )
  }

  console.log(`\nActions:`)
  console.log(`  npx ts-node scripts/review-candidates.ts --approve <id>`)
  console.log(`  npx ts-node scripts/review-candidates.ts --reject <id>`)
  console.log(`  npx ts-node scripts/review-candidates.ts --approve-all  (high-confidence only)\n`)
}

main()
