/**
 * constraint_violation detector — v0.2 cognitive signal
 *
 * Detects when a user's goal contains an explicit read-only / report-only
 * constraint, yet the agent performs write operations (edit_file, create_file,
 * npm install, etc.).
 *
 * This targets the "unauthorized_mutation" drift type: agent modifies code,
 * config, or dependencies when the user explicitly asked for a read-only
 * action (review, explain, audit, report).
 *
 * Detection logic:
 * 1. Extract read-only constraint from goal text via keyword matching
 * 2. Classify each event as read or write
 * 3. If constraint found AND write_count >= threshold → fire signal
 *
 * Zero-FP by design: only fires when the goal has an EXPLICIT constraint
 * AND the agent violates it with multiple writes. A single accidental
 * edit won't trigger; the threshold requires sustained write activity.
 */

import type { NormalizedEvent } from '../types'

export interface ConstraintViolationSignal {
  signal: 'constraint_violation'
  /** The constraint phrase detected in the goal */
  constraint_phrase: string
  /** Type of constraint: explicit "do not X" or implicit read-only intent */
  constraint_type: 'explicit_prohibition' | 'implicit_readonly'
  /** Number of write operations detected */
  write_count: number
  /** Index of the first write event */
  first_write_index: number
  /** Total events in the session */
  total_events: number
}

/**
 * Explicit prohibition patterns: user says "do not change/modify/fix/edit".
 * These are the strongest signals — user directly forbids writes.
 */
const EXPLICIT_PROHIBITION_PATTERNS: RegExp[] = [
  // English: "do not" / "don't" + write verbs
  /\b(?:do\s+not|don'?t|never|no)\s+(?:make\s+(?:any\s+)?changes?|change|modify|edit|fix|update|alter|touch|write|install|upgrade|refactor|rewrite)/i,
  // "just report/review/explain, not fix"
  /\bjust\s+(?:report|review|explain|analyze|check|scan|audit|read|look|examine|inspect|summarize)/i,
  // "only report/read"
  /\b(?:only|merely)\s+(?:report|review|explain|read|check|scan|audit|analyze|summarize|list|show)/i,
  // "read-only" / "read only"
  /\bread[\s-]?only\b/i,
  // "without making changes" / "without modifying"
  /\bwithout\s+(?:making\s+(?:any\s+)?changes?|modifying|editing|fixing|changing|altering)/i,
  // Chinese explicit prohibitions
  /不要(?:修改|改动|变更|编辑|更改|动|改)/,
  /只(?:看|读|查看|检查|报告|分析|审查|汇报)/,
  /仅(?:查看|报告|分析|审查)/,
]

/**
 * Implicit read-only intent: the goal itself is a read-only action
 * (explain, review, audit) with no write verbs.
 *
 * These are weaker signals — only fire when combined with high write counts.
 */
const IMPLICIT_READONLY_PATTERNS: RegExp[] = [
  // "Explain how X works" / "Walk me through X"
  /^(?:explain|walk\s+me\s+through|describe|tell\s+me\s+(?:about|how))\b/i,
  // "Review the PR/code/changes"
  /^(?:review|audit|analyze|inspect|check|examine|scan)\s+(?:the|this|our|my)\b/i,
  // "What does X do" / "How does X work"
  /^(?:what|how)\s+(?:does|do|is|are)\b/i,
  // Chinese read-only intents
  /^(?:解释|说明|介绍|描述|分析|审查|检查|查看)/,
]

/**
 * Write tool patterns: tools that modify state.
 */
const WRITE_TOOL_NAMES = new Set([
  'edit_file', 'Edit', 'file_replace',
  'create_file', 'Write',
  'delete_file',
])

/**
 * Bash commands that are write operations.
 */
const WRITE_BASH_PATTERNS: RegExp[] = [
  /\bnpm\s+(?:install|i|update|upgrade|audit\s+fix)\b/,
  /\bpip\s+install\b/,
  /\byarn\s+(?:add|upgrade)\b/,
  /\bpnpm\s+(?:add|install|update)\b/,
  /\bgit\s+(?:commit|push|merge|rebase|checkout\s+-b)\b/,
  /\bmvn\s+(?:deploy|release)\b/,
  /\bsed\s+-i\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\brm\s/,
  /\bmkdir\b/,
  /\bmv\s/,
  /\bcp\s/,
]

/** Minimum write operations to fire (avoids single accidental edit) */
const MIN_WRITES_EXPLICIT = 3
const MIN_WRITES_IMPLICIT = 5

function isWriteEvent(event: NormalizedEvent): boolean {
  if (WRITE_TOOL_NAMES.has(event.tool_name)) return true

  if (event.tool_name === 'bash' || event.tool_name === 'Bash') {
    const message = event.raw_message ?? ''
    return WRITE_BASH_PATTERNS.some(pattern => pattern.test(message))
  }

  return false
}

/**
 * Detect constraint violations in the event stream.
 *
 * @param events - Normalized event stream
 * @param goalText - The user's goal text
 * @returns Array of signals (0 or 1)
 */
export function detectConstraintViolation(
  events: NormalizedEvent[],
  goalText: string | undefined,
): ConstraintViolationSignal[] {
  if (!goalText || events.length === 0) return []

  // Step 1: Check for explicit prohibition
  let constraintPhrase = ''
  let constraintType: 'explicit_prohibition' | 'implicit_readonly' | null = null

  for (const pattern of EXPLICIT_PROHIBITION_PATTERNS) {
    const match = goalText.match(pattern)
    if (match) {
      constraintPhrase = match[0]
      constraintType = 'explicit_prohibition'
      break
    }
  }

  // Step 2: If no explicit prohibition, check for implicit read-only intent
  if (!constraintType) {
    for (const pattern of IMPLICIT_READONLY_PATTERNS) {
      const match = goalText.match(pattern)
      if (match) {
        constraintPhrase = match[0]
        constraintType = 'implicit_readonly'
        break
      }
    }
  }

  if (!constraintType) return []

  // Step 3: Count write operations
  const writeEvents = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => isWriteEvent(event))

  const writeCount = writeEvents.length
  const threshold = constraintType === 'explicit_prohibition'
    ? MIN_WRITES_EXPLICIT
    : MIN_WRITES_IMPLICIT

  if (writeCount < threshold) return []

  return [{
    signal: 'constraint_violation',
    constraint_phrase: constraintPhrase,
    constraint_type: constraintType,
    write_count: writeCount,
    first_write_index: writeEvents[0].index,
    total_events: events.length,
  }]
}
