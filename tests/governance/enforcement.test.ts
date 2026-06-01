/**
 * Tests for enforcement — translates an AuthorizationVerdict into a Claude Code
 * PreToolUse permission decision (track B / stage B2).
 *
 * Frozen v1 behavior:
 *   - only high-confidence `ask` hard-pauses (paused=true, permission='ask')
 *   - gray-zone `ask_soft` does NOT pause (permission='allow' + soft advisory)
 *   - `auto` silently allows
 *   - `block` (reserved) maps to 'deny' when ever emitted
 *   - escape valve: enforcement disabled → everything allow, nothing pauses
 */

import {
  resolveEnforcement,
  enforcementConfigFromEnv,
  toHookOutput,
  type EnforcementConfig,
} from '../../src/governance/enforcement'
import type { AuthorizationVerdict, AuthorizationDecision } from '../../src/governance/policy'

const ON: EnforcementConfig = { enabled: true }
const OFF: EnforcementConfig = { enabled: false }

function verdict(
  decision: AuthorizationDecision,
  high_confidence: boolean,
  score = 0.5,
): AuthorizationVerdict {
  return { decision, score, high_confidence, reason: `reason for ${decision}` }
}

describe('resolveEnforcement — verdict → permission decision', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Escape valve
  // ──────────────────────────────────────────────────────────────────────────

  it('escape valve: disabled enforcement never pauses, always allow', () => {
    const high = resolveEnforcement(verdict('ask', true, 0.9), OFF)
    expect(high.permissionDecision).toBe('allow')
    expect(high.paused).toBe(false)

    const block = resolveEnforcement(verdict('block', true, 0.99), OFF)
    expect(block.permissionDecision).toBe('allow')
    expect(block.paused).toBe(false)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // High-confidence ask — the only thing that hard-pauses in v1
  // ──────────────────────────────────────────────────────────────────────────

  it('high-confidence ask hard-pauses with permission=ask', () => {
    const r = resolveEnforcement(verdict('ask', true, 0.85), ON)
    expect(r.permissionDecision).toBe('ask')
    expect(r.paused).toBe(true)
    expect(r.soft_advisory).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Gray zone — must NOT pause
  // ──────────────────────────────────────────────────────────────────────────

  it('gray-zone ask_soft allows but surfaces a soft advisory (no pause)', () => {
    const r = resolveEnforcement(verdict('ask_soft', false, 0.6), ON)
    expect(r.permissionDecision).toBe('allow')
    expect(r.paused).toBe(false)
    expect(r.soft_advisory).toContain('reason for ask_soft')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // auto — silent allow
  // ──────────────────────────────────────────────────────────────────────────

  it('auto silently allows with no advisory', () => {
    const r = resolveEnforcement(verdict('auto', false, 0.2), ON)
    expect(r.permissionDecision).toBe('allow')
    expect(r.paused).toBe(false)
    expect(r.soft_advisory).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // block — reserved, maps to deny when emitted
  // ──────────────────────────────────────────────────────────────────────────

  it('block maps to permission=deny and pauses', () => {
    const r = resolveEnforcement(verdict('block', true, 0.99), ON)
    expect(r.permissionDecision).toBe('deny')
    expect(r.paused).toBe(true)
  })
})

describe('enforcementConfigFromEnv', () => {
  it('off by default (env unset)', () => {
    expect(enforcementConfigFromEnv({}).enabled).toBe(false)
  })

  it('on for DRIFT_ENFORCE=1 / true (case-insensitive)', () => {
    expect(enforcementConfigFromEnv({ DRIFT_ENFORCE: '1' }).enabled).toBe(true)
    expect(enforcementConfigFromEnv({ DRIFT_ENFORCE: 'true' }).enabled).toBe(true)
    expect(enforcementConfigFromEnv({ DRIFT_ENFORCE: 'TRUE' }).enabled).toBe(true)
  })

  it('off for any other value', () => {
    expect(enforcementConfigFromEnv({ DRIFT_ENFORCE: '0' }).enabled).toBe(false)
    expect(enforcementConfigFromEnv({ DRIFT_ENFORCE: 'no' }).enabled).toBe(false)
  })
})

describe('toHookOutput — cross-CLI PreToolUse JSON contract (Claude + codex)', () => {
  it('block → emits permissionDecision=deny (the one value both CLIs honor)', () => {
    const r = resolveEnforcement(verdict('block', true, 0.99), ON)
    const out = toHookOutput(r)
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(typeof out.hookSpecificOutput.permissionDecisionReason).toBe('string')
  })

  it('ask → OMITS permissionDecision (codex rejects non-deny; pause not portable)', () => {
    const r = resolveEnforcement(verdict('ask', true, 0.85), ON)
    const out = toHookOutput(r)
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined()
    // reason is still carried for logging/explainability
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('reason for ask')
  })

  it('allow → OMITS permissionDecision (silence = proceed on both CLIs)', () => {
    const r = resolveEnforcement(verdict('auto', false, 0.2), ON)
    const out = toHookOutput(r)
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined()
  })

  it('never serializes "allow" or "ask" as a permissionDecision value (codex guard)', () => {
    for (const v of ['auto', 'ask_soft', 'ask'] as const) {
      const out = toHookOutput(resolveEnforcement(verdict(v, true, 0.8), ON))
      expect(out.hookSpecificOutput.permissionDecision).not.toBe('allow')
      expect(out.hookSpecificOutput.permissionDecision).not.toBe('ask')
    }
  })
})
