/**
 * Review auto-collected candidate fixtures.
 *
 * Lists candidates in eval/candidates/, lets you promote (move to
 * fixtures-valid/) or reject (delete) them.
 *
 * IMPORTANT — no auto-groundtruth: promoting a candidate does NOT accept the
 * scorer's own drift prediction as the label. The prediction is the very thing
 * eval is supposed to grade, so promoting it as groundtruth would let the model
 * validate itself and inflate Precision/Recall. Promoted fixtures land with
 * label.drift UNSET and groundtruth_quality 'unreviewed'; a human must label
 * them before they count toward the STRONG-tier headline metric.
 *
 * Usage:
 *   npx ts-node scripts/review-candidates.ts                  # list all candidates
 *   npx ts-node scripts/review-candidates.ts --approve <id>   # promote one (pending human label)
 *   npx ts-node scripts/review-candidates.ts --reject <id>    # delete candidate
 *   npx ts-node scripts/review-candidates.ts --approve-all    # dry-run: list high-confidence
 *   npx ts-node scripts/review-candidates.ts --approve-all --force  # actually promote them
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

  // Assign a proper case_NNN ID — scan BOTH directories to avoid collisions
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  const MAIN_FIXTURES_DIR = path.resolve(__dirname, '../eval/fixtures')
  const allDirs = [FIXTURES_DIR]
  if (fs.existsSync(MAIN_FIXTURES_DIR)) allDirs.push(MAIN_FIXTURES_DIR)

  let maxNum = 0
  for (const dir of allDirs) {
    for (const f of fs.readdirSync(dir)) {
      const match = f.match(/^case_(\d+)\.json$/)
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
    }
  }
  const nextNum = maxNum + 1
  const caseId = `case_${String(nextNum).padStart(3, '0')}`

  // Transform auto_label into a label WITHOUT inheriting the model's own drift
  // verdict as groundtruth. The auto_label.drift is the SCORER'S prediction —
  // promoting it straight into label.drift and stamping annotated_by:'human'
  // creates a self-validating loop: the model grades itself against its own
  // past predictions and Precision/Recall inflate. So we carry the prediction
  // forward only as a hint (model_prediction), leave the groundtruth label
  // unset, and mark it unreviewed so a real human must fill drift/drift_type
  // before this fixture counts toward the STRONG-tier headline metric.
  const fixture = {
    ...data,
    id: `fixture_${String(nextNum).padStart(3, '0')}`,
    source: 'auto_collected_pending_review',
    label: {
      session_id: data.session?.id ?? data.id,
      drift: null,                          // groundtruth NOT set — human must label
      drift_type: undefined,                // do not hard-code; human decides
      takeover_required: null,
      model_prediction: {                   // the scorer's own guess, kept for the reviewer
        drift: data.auto_label.drift,
        final_score: data.auto_label.final_score,
        composite_score: data.auto_label.composite_score,
        cognitive_signals: data.auto_label.cognitive_signals,
        confidence: data.auto_label.confidence,
      },
      annotator_notes: `Auto-collected (model predicted ${data.auto_label.drift ? 'DRIFT' : 'ALIGNED'}, score=${data.auto_label.final_score.toFixed(3)}, confidence=${data.auto_label.confidence}). LABEL NOT YET REVIEWED — set drift/drift_type by hand.`,
      annotated_by: 'auto_collected' as const,
      groundtruth_quality: 'unreviewed' as const,
    },
  }
  delete fixture.auto_label
  delete fixture.needs_review

  const destPath = path.join(FIXTURES_DIR, `${caseId}.json`)
  fs.writeFileSync(destPath, JSON.stringify(fixture, null, 2))
  fs.unlinkSync(sourcePath)

  console.log(`✅ Promoted (pending human label): ${filename} → ${caseId}.json`)
  console.log(`   Goal: "${data.session?.goals?.[0]?.raw?.slice(0, 60)}"`)
  console.log(`   Model prediction: ${data.auto_label.drift ? 'DRIFT' : 'ALIGNED'} (score=${data.auto_label.final_score.toFixed(3)}) — groundtruth still UNSET`)
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

/**
 * Promote all high-confidence candidates into the fixture set.
 *
 * IMPORTANT: "high confidence" is the SCORER'S confidence in its own
 * prediction — not a human's confidence in the label being correct. Bulk
 * promotion still does NOT write groundtruth (approveCandidate leaves
 * label.drift unset); these fixtures land as `unreviewed` and a human must
 * label them before they count toward the STRONG-tier headline metric.
 *
 * Because even bulk promotion needs a deliberate action, this is a dry-run by
 * default — it lists what WOULD be promoted. Pass --force to actually move them.
 */
function approveAllHighConfidence(force: boolean): void {
  const candidates = listCandidates().filter(c => c.confidence === 'high')
  if (candidates.length === 0) {
    console.log('No high-confidence candidates to promote.')
    return
  }

  if (!force) {
    console.log(`\n⚠️  ${candidates.length} high-confidence candidate(s) would be promoted to fixtures-valid/`)
    console.log('   These are the SCORER\'S high-confidence PREDICTIONS, not human-verified labels.')
    console.log('   Promotion leaves groundtruth UNSET — a human must still label each one.\n')
    for (const c of candidates) {
      console.log(`   ${c.id}  predicted=${c.drift ? 'DRIFT' : 'ALIGNED'}  score=${c.score.toFixed(2)}  "${c.goal.slice(0, 40)}"`)
    }
    console.log('\n   This was a dry-run. Re-run with --force to actually promote (still pending human label).\n')
    return
  }

  console.log(`Promoting ${candidates.length} high-confidence candidate(s) (groundtruth still UNSET)...\n`)
  for (const candidate of candidates) {
    approveCandidate(candidate.id)
  }
  console.log('\n⚠️  All promoted fixtures are marked `unreviewed`. Label drift/drift_type by hand before using in eval.')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  npx ts-node scripts/review-candidates.ts                       # list candidates
  npx ts-node scripts/review-candidates.ts --approve <id>        # promote one (groundtruth left UNSET)
  npx ts-node scripts/review-candidates.ts --reject <id>         # reject one
  npx ts-node scripts/review-candidates.ts --approve-all         # dry-run: list high-confidence
  npx ts-node scripts/review-candidates.ts --approve-all --force # actually promote (still pending human label)

Note: promoting NEVER accepts the scorer's drift prediction as groundtruth.
Promoted fixtures are 'unreviewed' — a human must label drift/drift_type before
they count in the STRONG-tier metric.
`)
    return
  }

  if (args.includes('--approve-all')) {
    approveAllHighConfidence(args.includes('--force'))
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
  console.log('  (the "Predicted" column is the SCORER\'S guess, not a verified label)\n')
  console.log('  ID                          | Predicted | Conf   | Score | Events | Goal')
  console.log('  ----------------------------|-----------|--------|-------|--------|------')

  for (const c of candidates) {
    const predicted = c.drift ? 'DRIFT' : 'ALIGNED'
    const goalPreview = c.goal.slice(0, 40) + (c.goal.length > 40 ? '...' : '')
    console.log(
      `  ${c.id.padEnd(28)} | ${predicted.padEnd(9)} | ${c.confidence.padEnd(6)} | ${c.score.toFixed(2).padStart(5)} | ${String(c.eventCount).padStart(6)} | ${goalPreview}`
    )
  }

  console.log(`\nActions:`)
  console.log(`  npx ts-node scripts/review-candidates.ts --approve <id>   (promote — groundtruth left UNSET)`)
  console.log(`  npx ts-node scripts/review-candidates.ts --reject <id>`)
  console.log(`  npx ts-node scripts/review-candidates.ts --approve-all    (dry-run; add --force to promote)\n`)
}

main()
