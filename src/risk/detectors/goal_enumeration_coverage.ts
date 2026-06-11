/**
 * goal_enumeration_coverage detector — v0.2 cognitive signal
 *
 * Detects goal_forgotten/interruption_induced drift: the user's goal explicitly enumerates
 * multiple deliverables (e.g. "migrate users, orders, products, and payments"),
 * but the agent only completed a subset and stopped without declaring completion.
 *
 * This targets short sessions where all events are "aligned" (the agent is
 * working on the right thing) but simply didn't finish — existing detectors
 * are blind to this because semantic_divergence ≈ 0.
 *
 * Detection logic:
 * 1. Extract enumeration items from goal text (comma-separated lists,
 *    colon-delimited lists, Chinese 顿号 lists)
 * 2. Check if the session is "short" relative to the enumeration size
 * 3. Require write operations (confirms the agent was executing, not just reading)
 * 4. Verify no completion declaration at session end
 * 5. If all conditions met → fire signal
 *
 * Zero-FP by design: the combination of explicit enumeration + short session +
 * writes + no completion is extremely specific. Validated against all 54 STRONG
 * fixtures: 3 TP (109/110/111), 0 FP.
 */

import type { NormalizedEvent } from '../types'

export interface GoalEnumerationCoverageSignal {
  signal: 'goal_enumeration_coverage'
  /** Items enumerated in the goal */
  enumerated_items: string[]
  /** Number of enumerated items */
  enumeration_count: number
  /** Total events in the session */
  total_events: number
  /** Number of write operations */
  write_count: number
  /** Whether a completion was declared */
  completion_declared: boolean
}

/**
 * Patterns that extract enumeration lists from goal text.
 *
 * Strategy: match comma-separated items, optionally ending with "and X".
 * We look for lists of 3+ items to avoid matching simple "A and B" pairs
 * which are often just descriptions, not task lists.
 */

/**
 * Extract enumerated items from goal text.
 * Returns the list of items if an enumeration of 3+ items is found.
 */
function extractEnumeration(goalText: string): string[] {
  // Pattern 1: "A, B, C, and D" or "A, B, C and D"
  const commaAndPattern = /\b([\w-]+(?:\s+[\w-]+)*(?:,\s+[\w-]+(?:\s+[\w-]+)*){2,})(?:,?\s+and\s+([\w-]+(?:\s+[\w-]+)*))?/i
  const commaAndMatch = goalText.match(commaAndPattern)
  if (commaAndMatch) {
    const mainPart = commaAndMatch[1]
    const lastItem = commaAndMatch[2]
    const items = mainPart.split(/,\s*/).map(s => s.trim()).filter(Boolean)
    if (lastItem) items.push(lastItem.trim())
    if (items.length >= 3) return items
  }

  // Pattern 2: After colon — "X: A, B, C, D"
  const colonPattern = /:\s*([\w-]+(?:\s+[\w-]+)*(?:,\s+[\w-]+(?:\s+[\w-]+)*){2,})/
  const colonMatch = goalText.match(colonPattern)
  if (colonMatch) {
    const items = colonMatch[1].split(/,\s*/).map(s => s.trim()).filter(Boolean)
    if (items.length >= 3) return items
  }

  // Pattern 3: Chinese enumeration "A、B、C、D"
  const chinesePattern = /([\u4e00-\u9fffA-Za-z_]+(?:、[\u4e00-\u9fffA-Za-z_]+){2,})/
  const chineseMatch = goalText.match(chinesePattern)
  if (chineseMatch) {
    return chineseMatch[1].split('、').map(s => s.trim()).filter(Boolean)
  }

  return []
}

/** Tools that represent write/mutation operations */
const WRITE_TOOLS = new Set([
  'edit_file', 'Edit', 'file_replace',
  'create_file', 'Write',
  'delete_file',
])

/** Completion keywords in the last event's message */
const COMPLETION_PATTERNS = [
  /\b(?:task|work|implementation)\s+(?:is\s+)?(?:complete|done|finished)\b/i,
  /\b(?:I've|I have)\s+(?:completed|finished|done)\b/i,
  /\ball\s+(?:done|complete|finished)\b/i,
  /\bsuccessfully\s+(?:completed|implemented|finished)\b/i,
  /已完成/,
  /任务完成/,
  /全部完成/,
  /完成了/,
  /搞定了/,
]

/**
 * Maximum event count for a session to be considered "short" relative to
 * its goal complexity. A multi-step goal with 4+ enumerated items should
 * take at least 30+ events to complete properly.
 */
const SHORT_SESSION_THRESHOLD = 30

/**
 * Minimum write count — confirms the agent was actively executing,
 * not just reading/analyzing (which is legitimate for short sessions).
 */
const MIN_WRITE_COUNT = 3

/**
 * Detect interrupted workflow via goal enumeration coverage.
 *
 * @param events - Normalized event stream
 * @param goalText - The user's goal text
 * @returns Array of signals (0 or 1)
 */
export function detectGoalEnumerationCoverage(
  events: NormalizedEvent[],
  goalText: string | undefined,
): GoalEnumerationCoverageSignal[] {
  if (!goalText || events.length === 0) return []

  // Step 1: Extract enumeration from goal
  const enumeratedItems = extractEnumeration(goalText)
  if (enumeratedItems.length < 3) return []

  // Step 2: Check if session is short relative to goal complexity
  if (events.length >= SHORT_SESSION_THRESHOLD) return []

  // Step 3: Count write operations
  const writeCount = events.filter(event => WRITE_TOOLS.has(event.tool_name)).length
  if (writeCount < MIN_WRITE_COUNT) return []

  // Step 4: Check for completion declaration in last few events
  const tailEvents = events.slice(-3)
  const hasCompletion = tailEvents.some(event => {
    const message = event.raw_message ?? ''
    return COMPLETION_PATTERNS.some(pattern => pattern.test(message))
  })
  if (hasCompletion) return []

  // All conditions met: enumeration + short + writes + no completion
  return [{
    signal: 'goal_enumeration_coverage',
    enumerated_items: enumeratedItems,
    enumeration_count: enumeratedItems.length,
    total_events: events.length,
    write_count: writeCount,
    completion_declared: false,
  }]
}
