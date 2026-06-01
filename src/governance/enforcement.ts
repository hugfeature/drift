/**
 * Enforcement — translates an AuthorizationVerdict into a Claude Code
 * PreToolUse permission decision. This is the runtime "hand" of track B
 * (RFC stage B2): the layer that can actually pause the agent.
 *
 * ## What ships in v1 (frozen)
 *
 *   - Only the HIGH-CONFIDENCE band hard-pauses the agent. B1 STRONG-tier
 *     replay measured 0% false-interception for `ask` (score ≥ 0.75), so
 *     pausing here costs zero clean sessions.
 *   - The GRAY zone (`ask_soft`, 0.45–0.75, ~30% false-interception) does NOT
 *     pause — it only logs a soft advisory and lets the call proceed.
 *   - `auto` proceeds silently.
 *   - `block` is never emitted (policy enable_block defaults false).
 *
 * ## Escape valve
 *
 * Enforcement is OFF unless explicitly enabled (DRIFT_ENFORCE=1). When off,
 * every decision degrades to `allow` and the agent is never paused — preserving
 * the original hook's "never block the agent on Drift logic" safety philosophy.
 * This guarantees a single env var rolls back to pure advisory behavior.
 *
 * ## Output contract (cross-CLI: Claude Code + codex)
 *
 * Only an active intervention emits `permissionDecision`. "Proceed" is encoded
 * as SILENCE (no permissionDecision field), because that is the one behavior
 * both CLIs agree on:
 *
 *   - Claude Code: a missing permissionDecision = default-allow.
 *   - codex CLI:   only understands `deny`; receiving `allow` (or `ask`) throws
 *                  "unsupported permissionDecision". So we must NOT send them.
 *
 * Therefore:
 *   - deny  → emit { permissionDecision: "deny", ... }   (both CLIs honor it)
 *   - ask   → SILENCE on stdout (Claude's `ask` pause is not portable; the
 *             pause intent is surfaced via stderr advisory instead). codex has
 *             no "ask" semantic, and downgrading it to deny would turn "confirm"
 *             into "hard-kill" — against the frozen "first version only asks,
 *             never blocks" decision.
 *   - allow → SILENCE on stdout.
 *
 *   { hookSpecificOutput: { hookEventName: "PreToolUse",
 *       permissionDecision?: "deny",   // omitted entirely when proceeding
 *       permissionDecisionReason: string } }
 */

import type { AuthorizationVerdict } from './policy'

export type PermissionDecision = 'ask' | 'deny' | 'allow'

export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    /**
     * Omitted entirely when the hook is letting the call proceed. Only present
     * for a hard `deny`, the single decision value both Claude Code and codex
     * understand. See the output-contract note above.
     */
    permissionDecision?: PermissionDecision
    permissionDecisionReason: string
  }
}

export interface EnforcementResult {
  /** The decision Claude Code will act on */
  permissionDecision: PermissionDecision
  /** Whether the agent is actually paused (only true for hard ask/deny) */
  paused: boolean
  /** A soft advisory to print without pausing (gray zone), if any */
  soft_advisory: string | null
  /** Reason text surfaced to the user / model */
  reason: string
}

export interface EnforcementConfig {
  /**
   * Master switch. When false, enforcement degrades to pure advisory:
   * everything is `allow`, nothing pauses. Default false (opt-in).
   */
  enabled: boolean
}

/**
 * Read the enforcement config from the environment. Off unless DRIFT_ENFORCE
 * is a truthy value ("1" / "true").
 */
export function enforcementConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EnforcementConfig {
  const raw = (env.DRIFT_ENFORCE ?? '').trim().toLowerCase()
  return { enabled: raw === '1' || raw === 'true' }
}

/**
 * Decide the PreToolUse outcome from a policy verdict.
 *
 * Only verdicts with `high_confidence === true` (the `ask` band) hard-pause.
 * The gray-zone `ask_soft` returns `allow` plus a soft advisory string.
 */
export function resolveEnforcement(
  verdict: AuthorizationVerdict,
  config: EnforcementConfig,
): EnforcementResult {
  // Escape valve: enforcement disabled → never pause.
  if (!config.enabled) {
    return {
      permissionDecision: 'allow',
      paused:             false,
      soft_advisory:      null,
      reason:             'Drift enforcement disabled (advisory only)',
    }
  }

  // High-confidence band → hard pause via `ask`.
  if (verdict.decision === 'ask' && verdict.high_confidence) {
    return {
      permissionDecision: 'ask',
      paused:             true,
      soft_advisory:      null,
      reason:             verdict.reason,
    }
  }

  // Reserved hard deny — only if policy ever emits `block`.
  if (verdict.decision === 'block') {
    return {
      permissionDecision: 'deny',
      paused:             true,
      soft_advisory:      null,
      reason:             verdict.reason,
    }
  }

  // Gray zone → do NOT pause; surface a soft advisory and allow.
  if (verdict.decision === 'ask_soft') {
    return {
      permissionDecision: 'allow',
      paused:             false,
      soft_advisory:      `⚠️  ${verdict.reason}`,
      reason:             verdict.reason,
    }
  }

  // auto (or any unexpected case) → silently allow.
  return {
    permissionDecision: 'allow',
    paused:             false,
    soft_advisory:      null,
    reason:             verdict.reason,
  }
}

/**
 * Serialize an EnforcementResult into PreToolUse hook JSON that is safe for BOTH
 * Claude Code and codex.
 *
 * Only `deny` carries a permissionDecision — it is the one value both CLIs
 * honor. `allow` and `ask` proceed via SILENCE (the field is omitted), so codex
 * never sees an unsupported value and Claude Code default-allows. The reason is
 * always included for logging/explainability.
 */
export function toHookOutput(result: EnforcementResult): PreToolUseHookOutput {
  const base = {
    hookEventName:            'PreToolUse' as const,
    permissionDecisionReason: result.reason,
  }
  if (result.permissionDecision === 'deny') {
    return { hookSpecificOutput: { ...base, permissionDecision: 'deny' } }
  }
  // allow / ask → proceed silently (no permissionDecision field).
  return { hookSpecificOutput: base }
}
