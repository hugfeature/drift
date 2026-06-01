/**
 * Risk Layer v0.1 — Fixture loader
 * Loads fixtures, filters eligible ones, extracts raw events.
 *
 * Eligibility (current, post-v0.2):
 *   - filename starts with `case_` and ends with `.json`
 *   - has at least MIN_ELIGIBLE_EVENTS events
 *
 * The recovery-trigger exclusion from RFC §2 is intentionally DISABLED — see
 * the note on MIN_ELIGIBLE_EVENTS and the removed isRecoveryTrigger logic below.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { RawFixture, RawFixtureEvent } from './types'

const FIXTURES_DIR = path.resolve(__dirname, '../../eval/fixtures')

/**
 * Minimum events for a fixture to be eligible.
 *
 * This is 2, NOT the 5 the RFC originally specified. The threshold was lowered
 * deliberately: case_066 (false_environment_assumption) has only 4 events but
 * is a real, correctly-detected drift (a v0.2 true positive). A threshold of 5
 * would silently drop a valid in-scope case. Eligibility (this gate) is a
 * separate concept from WINDOW_SIZE=5 in risk-replay — the latter governs
 * risk/baseline window slicing, not which fixtures are loaded. Do not conflate.
 */
const MIN_ELIGIBLE_EVENTS = 2

export interface LoadedFixture {
  caseId: string
  filePath: string
  raw: RawFixture
  events: RawFixtureEvent[]
}

/**
 * Load all fixture files from eval/fixtures/.
 * Returns only eligible fixtures (see MIN_ELIGIBLE_EVENTS).
 *
 * Note on recovery filtering: the RFC §2 recovery-trigger exclusion is no
 * longer applied. Cases once treated as recovery-only (e.g. case_063/064/067)
 * now carry their pre-remediation events and must be evaluated. The previous
 * isRecoveryTrigger() gate had degenerated into a no-op (empty ID set + a
 * commented-out session_trigger_type check) — dead code that pretended to
 * filter. It has been removed rather than left as a misleading stub.
 */
export function loadEligibleFixtures(
  fixturesDir: string = FIXTURES_DIR,
  minEvents: number = MIN_ELIGIBLE_EVENTS,
): LoadedFixture[] {
  const files = fs.readdirSync(fixturesDir)
    .filter(f => f.startsWith('case_') && f.endsWith('.json'))
    .sort()

  const eligible: LoadedFixture[] = []

  for (const file of files) {
    const filePath = path.join(fixturesDir, file)
    const content = fs.readFileSync(filePath, 'utf-8')
    const raw: RawFixture = JSON.parse(content)

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
