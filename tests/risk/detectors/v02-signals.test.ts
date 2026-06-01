/**
 * Unit tests for v0.2 risk-layer detectors.
 *
 * These exercise the three cognitive-layer signals (completion_coverage_gap,
 * assertion_without_verification, obligation_closure_check) plus the two v0.1
 * detectors (stale_context, retry_density) that still ship in the v0.2 bundle.
 *
 * Inputs are hand-crafted NormalizedEvent[] streams — we do NOT go through the
 * fixture loader / normalizer here. That keeps each test pinned to one signal
 * behaviour without coupling to the much larger fixture schema.
 */

import {
  detectCompletionCoverageGap,
  extractQuantityConstraints,
} from '../../../src/risk/detectors/completion-coverage'
import { detectAssertionWithoutVerification } from '../../../src/risk/detectors/assertion-without-verification'
import { detectObligationClosure } from '../../../src/risk/detectors/obligation-closure'
import { detectStaleContext } from '../../../src/risk/detectors/stale-context'
import { detectRetryDensity } from '../../../src/risk/detectors/retry-density'
import type { NormalizedEvent } from '../../../src/risk/types'

let eventCounter = 0

function makeEvent(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  eventCounter += 1
  return {
    index: eventCounter - 1,
    timestamp: 1_700_000_000_000 + eventCounter * 1000,
    tool_name: 'Bash',
    domain: 'unknown',
    is_refresh: false,
    outcome: 'unknown',
    ...overrides,
  }
}

beforeEach(() => {
  eventCounter = 0
})

// ────────────────────────────────────────────────────────────────────────────
// completion_coverage_gap
// ────────────────────────────────────────────────────────────────────────────

describe('detectCompletionCoverageGap', () => {
  it('fires when prompt asks for two but only one artifact was written', () => {
    const events: NormalizedEvent[] = [
      makeEvent({
        tool_name: 'Write',
        domain: 'code',
        tool_target: '/articles/post-a/index.md',
      }),
      makeEvent({
        tool_name: 'mcp__engram__track_progress',
        domain: 'task_mgmt',
        raw_message: 'feature=publish status=done completion=100',
      }),
    ]

    const signals = detectCompletionCoverageGap(events, '请帮我写twopublished文章')

    expect(signals).toHaveLength(1)
    expect(signals[0].expected_output_count).toBe(2)
    expect(signals[0].actual_output_count).toBe(1)
    expect(signals[0].prompt_constraints[0].quantity).toBe(2)
  })

  it('stays silent when actual output matches the prompt quantity', () => {
    const events: NormalizedEvent[] = [
      makeEvent({ tool_name: 'Write', domain: 'code', tool_target: '/a/post-1.md' }),
      makeEvent({ tool_name: 'Write', domain: 'code', tool_target: '/b/post-2.md' }),
      makeEvent({
        tool_name: 'mcp__engram__track_progress',
        domain: 'task_mgmt',
        raw_message: 'delivery complete',
      }),
    ]

    const signals = detectCompletionCoverageGap(events, '请写two文章')
    expect(signals).toHaveLength(0)
  })

  it('returns nothing when the prompt has no quantity constraint', () => {
    const events: NormalizedEvent[] = [
      makeEvent({ tool_name: 'Write', domain: 'code', tool_target: '/notes.md' }),
      makeEvent({
        tool_name: 'mcp__engram__track_progress',
        domain: 'task_mgmt',
        raw_message: 'status=done',
      }),
    ]

    const signals = detectCompletionCoverageGap(events, 'help me jot down some notes')
    expect(signals).toHaveLength(0)
  })

  it('extracts both Chinese and Arabic quantities, ignoring quantity=1 and quantity>20', () => {
    const constraints = extractQuantityConstraints(
      '请写two文章和 3 reports, 不要超过 25 items 同时只交付 1 个 summary',
    )

    const raws = constraints.map(c => c.raw_match)
    expect(raws).toContain('two')
    expect(raws).toContain('3 reports')
    // quantity=1 and quantity>20 must be filtered out
    expect(raws.some(r => /1 个|25 items/.test(r))).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// assertion_without_verification
// ────────────────────────────────────────────────────────────────────────────

describe('detectAssertionWithoutVerification', () => {
  it('fires when the agent rationalises ("可能是预发环境") without checking the URL', () => {
    const events: NormalizedEvent[] = [
      makeEvent({
        tool_name: 'explanation',
        domain: 'unknown',
        raw_message:
          '看到 tenant 标签是 test，可能是预发环境的 display name 配置不同步导致的，应该不影响功能',
      }),
    ]

    const signals = detectAssertionWithoutVerification(events)

    expect(signals).toHaveLength(1)
    expect(signals[0].claimed_resource).toMatch(/environment:/)
    expect(signals[0].user_corrected).toBe(false)
  })

  it('upgrades to high confidence when a user correction follows the assertion', () => {
    const events: NormalizedEvent[] = [
      makeEvent({
        tool_name: 'explanation',
        domain: 'unknown',
        raw_message: '应该是预发环境的 display name 没同步',
      }),
      makeEvent({
        tool_name: 'explanation',
        domain: 'unknown',
        raw_message: '不对，根本不是预发，是生产配错了',
      }),
    ]

    const signals = detectAssertionWithoutVerification(events)

    expect(signals).toHaveLength(1)
    expect(signals[0].user_corrected).toBe(true)
    expect(signals[0].confidence).toBe('high')
  })

  it('does NOT fire when the same resource was read earlier in the window', () => {
    const events: NormalizedEvent[] = [
      makeEvent({
        tool_name: 'Read',
        domain: 'read',
        tool_target: '/etc/hooks.json',
        raw_message: 'hooks.json',
      }),
      makeEvent({
        tool_name: 'explanation',
        domain: 'unknown',
        raw_message: 'hooks.json 已经配置好了 SessionStart hook injection',
      }),
    ]

    const signals = detectAssertionWithoutVerification(events)
    expect(signals).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// obligation_closure_check
// ────────────────────────────────────────────────────────────────────────────

describe('detectObligationClosure', () => {
  it('fires when only some of the required drift hooks are registered', () => {
    // drift_hook_registration requires all 4: SessionStart, UserPromptSubmit, PostToolUse, Stop.
    // This session only registers 2 → 2 missing.
    const events: NormalizedEvent[] = [
      makeEvent({
        tool_name: 'Edit',
        domain: 'code',
        tool_target: '/etc/hooks.json',
        raw_message: 'add SessionStart hook to hooks.json',
      }),
      makeEvent({
        tool_name: 'Edit',
        domain: 'code',
        tool_target: '/etc/hooks.json',
        raw_message: 'add UserPromptSubmit hook to hooks.json',
      }),
    ]

    const signals = detectObligationClosure(events)

    expect(signals).toHaveLength(1)
    const closure = signals[0]
    expect(closure.obligation_type).toBe('drift_hook_registration')
    expect(closure.missing_obligations).toEqual(
      expect.arrayContaining(['PostToolUse', 'Stop']),
    )
    expect(closure.completion_ratio).toBeCloseTo(0.5, 5)
  })

  it('stays silent when all 4 required hooks are registered', () => {
    const events: NormalizedEvent[] = [
      makeEvent({
        tool_name: 'Edit',
        domain: 'code',
        tool_target: '/etc/hooks.json',
        raw_message: 'add SessionStart hook to hooks.json',
      }),
      makeEvent({
        tool_name: 'Edit',
        domain: 'code',
        tool_target: '/etc/hooks.json',
        raw_message: 'add UserPromptSubmit hook to hooks.json',
      }),
      makeEvent({
        tool_name: 'Edit',
        domain: 'code',
        tool_target: '/etc/hooks.json',
        raw_message: 'add PostToolUse hook to hooks.json',
      }),
      makeEvent({
        tool_name: 'Edit',
        domain: 'code',
        tool_target: '/etc/hooks.json',
        raw_message: 'add Stop hook to hooks.json',
      }),
    ]

    const signals = detectObligationClosure(events)
    expect(signals).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// stale_context (v0.1, still part of the v0.2 bundle)
// ────────────────────────────────────────────────────────────────────────────

describe('detectStaleContext', () => {
  it('fires when observation is followed by ≥5 gap events and a mutation on the same target with no refresh', () => {
    const target = '/src/config.ts'
    const events: NormalizedEvent[] = [
      makeEvent({ tool_name: 'Read', domain: 'read', tool_target: target }),
      makeEvent({ tool_name: 'Bash', domain: 'git' }),
      makeEvent({ tool_name: 'Bash', domain: 'git' }),
      makeEvent({ tool_name: 'Bash', domain: 'test' }),
      makeEvent({ tool_name: 'Bash', domain: 'test' }),
      makeEvent({ tool_name: 'Bash', domain: 'browser' }),
      makeEvent({ tool_name: 'Edit', domain: 'code', tool_target: target }),
    ]

    const signals = detectStaleContext(events)

    expect(signals).toHaveLength(1)
    expect(signals[0].stale_gap).toBeGreaterThanOrEqual(5)
  })

  it('does NOT fire when a Read of the same target refreshes the context before mutation', () => {
    const target = '/src/config.ts'
    const events: NormalizedEvent[] = [
      makeEvent({ tool_name: 'Read', domain: 'read', tool_target: target }),
      makeEvent({ tool_name: 'Bash', domain: 'git' }),
      makeEvent({ tool_name: 'Bash', domain: 'git' }),
      makeEvent({ tool_name: 'Bash', domain: 'git' }),
      makeEvent({ tool_name: 'Bash', domain: 'test' }),
      makeEvent({ tool_name: 'Bash', domain: 'browser' }),
      makeEvent({
        tool_name: 'Read',
        domain: 'read',
        tool_target: target,
        is_refresh: true,
      }),
      makeEvent({ tool_name: 'Edit', domain: 'code', tool_target: target }),
    ]

    const signals = detectStaleContext(events)
    expect(signals).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// retry_density (v0.1, still part of the v0.2 bundle)
// ────────────────────────────────────────────────────────────────────────────

describe('detectRetryDensity', () => {
  it('fires when the same Bash command is invoked 3 times inside a 5-event window', () => {
    const cmd = 'npm test -- --bail'
    const events: NormalizedEvent[] = [
      makeEvent({ tool_name: 'Bash', domain: 'test', raw_message: cmd }),
      makeEvent({ tool_name: 'Read', domain: 'read', tool_target: '/notes.md' }),
      makeEvent({ tool_name: 'Bash', domain: 'test', raw_message: cmd }),
      makeEvent({ tool_name: 'Bash', domain: 'test', raw_message: cmd }),
      makeEvent({ tool_name: 'Bash', domain: 'git', raw_message: 'git status' }),
    ]

    const signals = detectRetryDensity(events)

    expect(signals.length).toBeGreaterThanOrEqual(1)
    expect(signals[0].count).toBeGreaterThanOrEqual(3)
  })

  it('stays silent when only 2 retries fall inside the window', () => {
    const cmd = 'npm test'
    const events: NormalizedEvent[] = [
      makeEvent({ tool_name: 'Bash', domain: 'test', raw_message: cmd }),
      makeEvent({ tool_name: 'Read', domain: 'read', tool_target: '/a.md' }),
      makeEvent({ tool_name: 'Read', domain: 'read', tool_target: '/b.md' }),
      makeEvent({ tool_name: 'Read', domain: 'read', tool_target: '/c.md' }),
      makeEvent({ tool_name: 'Bash', domain: 'test', raw_message: cmd }),
    ]

    const signals = detectRetryDensity(events)
    expect(signals).toHaveLength(0)
  })
})
