/**
 * Tests for CandidateCollector — auto-collection of eval fixture candidates.
 *
 * Focus: the composite-gating behavior added so a session that a zero-FP
 * cognitive signal flagged (composite lifted to the cognitive floor) is
 * captured even when its raw v0.1 final_score stayed below the drift threshold.
 *
 * Each test writes to an isolated temp output dir and cleans up afterwards.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  CandidateCollector,
  type CandidateSession,
  type CandidateEvent,
} from '../../src/eval/candidate-collector'

function makeToolEvents(count: number): CandidateEvent[] {
  const events: CandidateEvent[] = []
  for (let i = 0; i < count; i++) {
    events.push({
      event_index: i + 1,
      timestamp: 1_700_000_000_000 + i * 1000,
      event_type: 'tool_call',
      tool_name: 'read_file',
      tool_input: { file_path: `src/file_${i}.ts` },
      drift_score: 0.2,
      status: 'aligned',
    })
  }
  return events
}

function baseSession(overrides: Partial<CandidateSession>): CandidateSession {
  return {
    session_id: 'sess_test_collect',
    started_at: 1_700_000_000_000,
    agent: 'claude-code',
    goal: 'Refactor the auth module to use async tokens',
    events: makeToolEvents(10),
    final_score: 0.2,
    final_status: 'aligned',
    event_count: 10,
    ...overrides,
  }
}

describe('CandidateCollector composite gating', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-collector-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('captures a session via composite even when v0.1 final_score is low', () => {
    const collector = new CandidateCollector({ outputDir: tmpDir })

    // v0.1 score 0.2 (below drift threshold 0.7) but a cognitive signal lifted
    // the composite to the floor 0.85 — should be collected as a drift candidate.
    const session = baseSession({
      final_score: 0.2,
      composite_score: 0.85,
      cognitive_signals: ['assertion_without_verification'],
    })

    const outputPath = collector.collect(session)
    expect(outputPath).not.toBeNull()

    const fixture = JSON.parse(fs.readFileSync(outputPath!, 'utf-8'))
    expect(fixture.auto_label.drift).toBe(true)
    expect(fixture.auto_label.final_score).toBe(0.2)
    expect(fixture.auto_label.composite_score).toBe(0.85)
    expect(fixture.auto_label.cognitive_signals).toContain('assertion_without_verification')
    expect(fixture.auto_label.reason).toContain('cognitive signal')
  })

  it('does NOT collect a low-v0.1 session when no composite lifts it', () => {
    const collector = new CandidateCollector({ outputDir: tmpDir })

    // Mid-range v0.1 score, no composite provided → falls back to v0.1, skipped.
    const session = baseSession({ final_score: 0.4 })

    const outputPath = collector.collect(session)
    expect(outputPath).toBeNull()
  })

  it('falls back to v0.1 final_score when composite_score is absent', () => {
    const collector = new CandidateCollector({ outputDir: tmpDir })

    // High v0.1 score, no composite → still collected via fallback path.
    const session = baseSession({ final_score: 0.8 })

    const outputPath = collector.collect(session)
    expect(outputPath).not.toBeNull()

    const fixture = JSON.parse(fs.readFileSync(outputPath!, 'utf-8'))
    expect(fixture.auto_label.drift).toBe(true)
    expect(fixture.auto_label.composite_score).toBeUndefined()
  })

  it('still respects the aligned threshold via composite', () => {
    const collector = new CandidateCollector({ outputDir: tmpDir })

    const session = baseSession({
      final_score: 0.1,
      composite_score: 0.1,
    })

    const outputPath = collector.collect(session)
    expect(outputPath).not.toBeNull()

    const fixture = JSON.parse(fs.readFileSync(outputPath!, 'utf-8'))
    expect(fixture.auto_label.drift).toBe(false)
  })
})
