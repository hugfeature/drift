/**
 * obligation_closure_check detector — v0.2 Signal 7
 * Detects when an agent performs a registration/setup action but
 * fails to complete the full set of downstream obligations.
 *
 * Pattern:
 *   1. Agent registers/configures something (hook, task, config)
 *   2. The registration implies a full obligation set (e.g., 4 hooks needed)
 *   3. At session end, not all obligations are fulfilled
 *
 * Targets: case_064 (1/4 hooks), case_065 (3/4 hooks)
 * Per RFC Appendix B §B.3
 */

import type { NormalizedEvent } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObligationClosureSignal {
  signal: 'obligation_closure_check'
  /** Event index of the first registration action */
  first_registration_index: number
  /** What was being registered/configured */
  obligation_type: string
  /** Full set of required obligations */
  required_obligations: string[]
  /** Which obligations were fulfilled */
  fulfilled_obligations: string[]
  /** Which obligations were missed */
  missing_obligations: string[]
  /** Completion ratio */
  completion_ratio: number
}

// ---------------------------------------------------------------------------
// Obligation definitions
// ---------------------------------------------------------------------------

/**
 * Known obligation sets: when you configure one item in this category,
 * you should configure ALL items in the set.
 */
interface ObligationSet {
  /** Pattern to detect this obligation type in events */
  detectionPattern: RegExp
  /** Extract which specific item was registered */
  itemExtractor: (event: NormalizedEvent) => string | undefined
  /** The complete set of required items */
  requiredItems: string[]
  /** Human-readable obligation type name */
  typeName: string
}

const OBLIGATION_SETS: ObligationSet[] = [
  {
    typeName: 'drift_hook_registration',
    detectionPattern: /hook|hooks\.json/i,
    itemExtractor: (event) => {
      const msg = event.raw_message || ''
      // Look for hook event names
      const hookNames = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']
      for (const hook of hookNames) {
        if (msg.includes(hook)) return hook
      }
      return undefined
    },
    requiredItems: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
  },
]

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/** Patterns indicating the agent considers setup "done" */
const COMPLETION_DECLARATION = /(?:done|完成|configured|设置好了|registered|已[配注])/i

/**
 * Detect obligation_closure_check signals.
 *
 * Strategy: scan events until the agent's FIRST completion declaration
 * (e.g., "Done. Hooks are configured."). Check obligation completeness
 * at that checkpoint — not at session end (which may include remediation).
 */
export function detectObligationClosure(
  events: NormalizedEvent[],
): ObligationClosureSignal[] {
  const signals: ObligationClosureSignal[] = []

  for (const obligationSet of OBLIGATION_SETS) {
    const fulfilledItems = new Set<string>()
    let firstRegistrationIndex = -1
    let completionDeclaredAt = -1

    for (const event of events) {
      const toolAndMsg = `${event.tool_name} ${event.raw_message || ''}`

      // Detect completion declaration — stop scanning here
      // Only trigger on explanation/response events (not tool actions that happen to say "registered")
      if (event.tool_name === 'explanation') {
        if (event.raw_message && COMPLETION_DECLARATION.test(event.raw_message)) {
          // Only treat as completion if we've already seen registrations
          if (firstRegistrationIndex !== -1) {
            completionDeclaredAt = event.index
            break
          }
        }
      }

      // Check if this event is relevant to this obligation set
      if (!obligationSet.detectionPattern.test(toolAndMsg)) continue

      const item = obligationSet.itemExtractor(event)
      if (!item) continue

      if (firstRegistrationIndex === -1) {
        firstRegistrationIndex = event.index
      }
      fulfilledItems.add(item)
    }

    // If no registration detected for this obligation type, skip
    if (firstRegistrationIndex === -1) continue

    // If no completion declaration found, use full session (backward compat)
    if (completionDeclaredAt === -1) {
      // Scan remaining events for obligations (full session mode)
      for (const event of events) {
        const toolAndMsg = `${event.tool_name} ${event.raw_message || ''}`
        if (!obligationSet.detectionPattern.test(toolAndMsg)) continue
        const item = obligationSet.itemExtractor(event)
        if (item) fulfilledItems.add(item)
      }
    }

    // Check completeness
    const required = obligationSet.requiredItems
    const fulfilled = required.filter(item => fulfilledItems.has(item))
    const missing = required.filter(item => !fulfilledItems.has(item))

    // Only fire if something is missing AND at least one item was configured
    if (missing.length > 0 && fulfilled.length > 0) {
      signals.push({
        signal: 'obligation_closure_check',
        first_registration_index: firstRegistrationIndex,
        obligation_type: obligationSet.typeName,
        required_obligations: required,
        fulfilled_obligations: fulfilled,
        missing_obligations: missing,
        completion_ratio: fulfilled.length / required.length,
      })
    }
  }

  return signals
}
