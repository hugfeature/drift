/**
 * Risk Layer v0.1 — Fixture loader
 * Loads fixtures, filters eligible ones, extracts raw events.
 * Per RFC §2: exclude recovery-trigger fixtures and 0-event fixtures.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { RawFixture, RawFixtureEvent } from './types'

const FIXTURES_DIR = path.resolve(__dirname, '../../eval/fixtures')

/** Recovery-trigger case IDs to exclude per RFC §2 */
// Note: case_063/064/067 were initially excluded as recovery-trigger sessions,
// but they now contain pre-remediation events for v0.2 signal evaluation.
const RECOVERY_CASE_IDS = new Set<string>([])

export interface LoadedFixture {
  caseId: string
  filePath: string
  raw: RawFixture
  events: RawFixtureEvent[]
}

/**
 * Check if a fixture is a recovery-trigger session.
 * Per RFC: identified by session_trigger_type:"recovery" or known case IDs.
 */
function isRecoveryTrigger(fixture: RawFixture): boolean {
  const triggerId = fixture.id ?? fixture.case_id ?? ''
  if (RECOVERY_CASE_IDS.has(triggerId)) return true

  // Note: session_trigger_type:"recovery" was used in early fixtures to mark
  // remediation-only sessions. Since v0.2, these fixtures contain pre-remediation
  // events and should be included. Disable this filter.
  // const triggerType = fixture.label?.session_trigger_type
  // if (triggerType === 'recovery') return true

  return false
}

/**
 * Load all fixture files from eval/fixtures/.
 * Returns only eligible fixtures (≥5 events, non-recovery).
 */
export function loadEligibleFixtures(
  fixturesDir: string = FIXTURES_DIR,
  minEvents: number = 2,
): LoadedFixture[] {
  const files = fs.readdirSync(fixturesDir)
    .filter(f => f.startsWith('case_') && f.endsWith('.json'))
    .sort()

  const eligible: LoadedFixture[] = []

  for (const file of files) {
    const filePath = path.join(fixturesDir, file)
    const content = fs.readFileSync(filePath, 'utf-8')
    const raw: RawFixture = JSON.parse(content)

    if (isRecoveryTrigger(raw)) continue

    const events = raw.session?.events ?? []
    if (events.length < minEvents) continue

    const caseId = raw.id ?? raw.case_id ?? path.basename(file, '.json')

    eligible.push({ caseId, filePath, raw, events })
  }

  return eligible
}

/**
 * Load a single fixture by file path.
 * Does NOT filter — returns the fixture regardless of eligibility.
 */
export function loadSingleFixture(filePath: string): LoadedFixture {
  const content = fs.readFileSync(filePath, 'utf-8')
  const raw: RawFixture = JSON.parse(content)
  const events = raw.session?.events ?? []
  const caseId = raw.id ?? raw.case_id ?? path.basename(filePath, '.json')
  return { caseId, filePath, raw, events }
}
