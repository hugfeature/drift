/**
 * premature_completion_claim detector — v0.2 Signal 8
 *
 * Detects when an agent declares completion in a suspiciously short session.
 * The agent says "done" / "已完成" but the tool_call count is too low to
 * plausibly cover a multi-step goal.
 *
 * This catches incomplete_followthrough drift: the agent "gives up early"
 * by claiming success after doing only a fraction of the work. Unlike
 * completion_coverage_gap (which needs explicit quantity constraints in the
 * prompt), this signal fires on structural shortness — the session simply
 * didn't do enough work to satisfy any non-trivial goal.
 *
 * Detection logic:
 * 1. Find completion declarations in the event stream (assistant messages
 *    containing completion keywords)
 * 2. Count meaningful tool_calls before the completion event
 * 3. If tool_calls < threshold AND the goal has multi-step indicators → fire
 *
 * This signal is a candidate for the zero-FP cognitive-hit whitelist,
 * pending eval validation.
 */

import type { NormalizedEvent } from '../types'

export interface PrematureCompletionSignal {
  signal: 'premature_completion_claim'
  /** Event index where completion was declared */
  completion_event_index: number
  /** Number of meaningful tool_calls before the completion */
  tool_call_count: number
  /** Whether the goal text contains multi-step indicators */
  goal_has_multi_step: boolean
  /** The completion phrase detected */
  completion_phrase: string
}

/**
 * Tools that represent meaningful work (not just reading/searching).
 * System/infrastructure tools excluded.
 */
const SYSTEM_TOOL_PATTERNS = [
  /^mcp__/,
  /^TaskCreate$/,
  /^TaskUpdate$/,
  /^TaskComplete$/,
  /^Agent$/,
]

function isSystemTool(toolName: string): boolean {
  return SYSTEM_TOOL_PATTERNS.some(pattern => pattern.test(toolName))
}

/**
 * Completion keywords in assistant messages.
 * Deliberately conservative — only strong "I'm done" signals.
 */
const COMPLETION_PATTERNS = [
  // Chinese
  /已完成/,
  /任务完成/,
  /全部完成/,
  /完成了/,
  /搞定了/,
  /做完了/,
  // English
  /\b(?:task|work|implementation)\s+(?:is\s+)?(?:complete|done|finished)\b/i,
  /\b(?:I've|I have)\s+(?:completed|finished|done)\b/i,
  /\ball\s+(?:done|complete|finished)\b/i,
  /\bsuccessfully\s+(?:completed|implemented|finished)\b/i,
]

/**
 * Multi-step goal indicators: if the goal text contains these,
 * the task likely requires more than a handful of tool_calls.
 */
const MULTI_STEP_PATTERNS = [
  // Numbered lists: "1. xxx 2. xxx" or "1、xxx 2、xxx"
  /(?:1[.、]|①).+(?:2[.、]|②)/s,
  // Enumeration: "A 和 B" / "X、Y、Z"
  /(?:和|与|以及|and)\s*.{2,}/,
  /[^，。\n]+(?:、[^，。\n]+){2,}/,
  // Explicit multi-task keywords
  /(?:所有|全部|每个|各个|分别|依次|逐个)/,
  /\b(?:all|each|every|both|multiple)\b/i,
  // Step/phase keywords
  /(?:步骤|阶段|环节|流程)/,
  /\b(?:steps?|phases?|stages?)\b/i,
]

/**
 * Maximum tool_call count for a session to be considered "premature".
 * Sessions with more tool_calls than this are unlikely to be premature
 * even if they declare completion.
 */
const MAX_TOOL_CALLS_FOR_PREMATURE = 8

/**
 * Minimum tool_call count for the signal to fire.
 * A session with 0-1 tool_calls might be a legitimate quick answer,
 * not a premature completion.
 */
const MIN_TOOL_CALLS_FOR_SIGNAL = 2

/**
 * Detect premature completion claims in the event stream.
 *
 * @param events - Normalized event stream
 * @param goalText - The goal text (first user message)
 * @returns Array of signals (typically 0 or 1)
 */
export function detectPrematureCompletion(
  events: NormalizedEvent[],
  goalText: string | undefined,
): PrematureCompletionSignal[] {
  if (!goalText) return []

  const goalHasMultiStep = MULTI_STEP_PATTERNS.some(pattern => pattern.test(goalText))

  // Count meaningful tool_calls (non-system, non-read)
  const meaningfulToolCalls = events.filter(
    event => event.tool_name !== 'unknown'
      && !isSystemTool(event.tool_name)
  )

  const totalMeaningful = meaningfulToolCalls.length

  // Too many tool_calls → not premature, even if completion is declared
  if (totalMeaningful > MAX_TOOL_CALLS_FOR_PREMATURE) return []

  // Too few tool_calls → might be a legitimate quick task
  if (totalMeaningful < MIN_TOOL_CALLS_FOR_SIGNAL) return []

  // Scan for completion declarations in raw_message fields
  const signals: PrematureCompletionSignal[] = []

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event.raw_message) continue

    const matchedPattern = COMPLETION_PATTERNS.find(
      pattern => pattern.test(event.raw_message!)
    )
    if (!matchedPattern) continue

    // Count tool_calls BEFORE this completion event
    const toolCallsBefore = events
      .slice(0, i)
      .filter(e => e.tool_name !== 'unknown' && !isSystemTool(e.tool_name))
      .length

    // Fire if:
    // - Few tool_calls before completion AND
    // - Goal has multi-step indicators (strong signal) OR tool_calls are very low
    const isVeryShort = toolCallsBefore <= 4
    const shouldFire = (goalHasMultiStep && toolCallsBefore < MAX_TOOL_CALLS_FOR_PREMATURE)
      || isVeryShort

    if (shouldFire) {
      const matchResult = event.raw_message!.match(matchedPattern)
      signals.push({
        signal: 'premature_completion_claim',
        completion_event_index: i,
        tool_call_count: toolCallsBefore,
        goal_has_multi_step: goalHasMultiStep,
        completion_phrase: matchResult?.[0] ?? 'completion detected',
      })
      break // Only the last completion event matters
    }
  }

  return signals
}
