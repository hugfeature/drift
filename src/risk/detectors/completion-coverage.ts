/**
 * completion_coverage_gap detector — v0.2 Signal 6
 * Detects mismatch between prompt-level quantity constraints and actual output count.
 *
 * Logic:
 * 1. Extract quantity constraints from the first user message (prompt)
 * 2. Identify completion events (task_mgmt tools with completion signals)
 * 3. Count actual output artifacts produced before completion
 * 4. If expected > actual → fire signal
 *
 * Per RFC Appendix B §B.3
 */

import type { NormalizedEvent, CompletionCoverageGapSignal, PromptQuantityConstraint } from '../types'

/**
 * Chinese quantity patterns: 两篇/三个/四条/五张/六项 etc.
 * Also handles mixed: 2篇, 3个
 */
const CHINESE_QUANTITY_PATTERNS = [
  // 中文数字 + 量词
  /([两三四五六七八九十])(篇|个|条|张|项|份|组|套|块|段|步|件|类)/g,
  // 阿拉伯数字 + 中文量词
  /(\d+)(篇|个|条|张|项|份|组|套|块|段|步|件|类)/g,
]

/**
 * English quantity patterns: "3 files", "two articles", "5 items"
 */
const ENGLISH_QUANTITY_PATTERNS = [
  // number + noun (plural)
  /(\d+)\s+(files?|articles?|items?|tasks?|steps?|parts?|sections?|documents?|reports?|tests?)/gi,
  // written numbers
  /(two|three|four|five|six|seven|eight|nine|ten)\s+(files?|articles?|items?|tasks?|steps?|parts?|sections?|documents?|reports?|tests?)/gi,
]

/**
 * Explicit enumeration: A + B + C / A、B、C / A 和 B
 * Captures "X 和 Y" or "X、Y、Z" patterns in task context
 */
const ENUMERATION_PATTERNS = [
  // "A" + "B" (quoted items joined by +/和/与)
  /[「"']([^「"']+)[」"']\s*[+和与]\s*[「"']([^「"']+)[」"']/g,
  // Items separated by 、(Chinese enumeration comma) — count items
  /(?:^|[\s：:])([^，。\n]+(?:、[^，。\n]+){1,})/g,
]

const CHINESE_NUM_MAP: Record<string, number> = {
  '两': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
}

const ENGLISH_NUM_MAP: Record<string, number> = {
  'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
}

/**
 * Extract quantity constraints from prompt text.
 * 
 * Strategy: User instructions typically appear at the END of a prompt
 * (especially when the prompt includes pasted content/drafts).
 * We prioritize the tail of the prompt for constraint extraction.
 * If tail has constraints, use those; otherwise fallback to full scan.
 */
export function extractQuantityConstraints(promptText: string): PromptQuantityConstraint[] {
  // For short prompts, scan everything
  if (promptText.length <= 300) {
    return extractFromText(promptText)
  }

  // For long prompts: instruction is usually at the tail
  const tail = promptText.slice(-300)
  const tailConstraints = extractFromText(tail)

  if (tailConstraints.length > 0) {
    return tailConstraints
  }

  // Fallback: check the head (instruction might be at the beginning)
  const head = promptText.slice(0, 300)
  return extractFromText(head)
}

/**
 * Low-level extraction: scan a text segment for quantity patterns.
 */
function extractFromText(text: string): PromptQuantityConstraint[] {
  const constraints: PromptQuantityConstraint[] = []
  const seen = new Set<string>()

  for (const pattern of CHINESE_QUANTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const rawMatch = match[0]
      if (seen.has(rawMatch)) continue
      seen.add(rawMatch)

      const numStr = match[1]
      const unit = match[2]
      const quantity = CHINESE_NUM_MAP[numStr] ?? parseInt(numStr, 10)

      if (quantity > 1 && quantity <= 20) {
        constraints.push({ raw_match: rawMatch, quantity, unit })
      }
    }
  }

  for (const pattern of ENGLISH_QUANTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const rawMatch = match[0]
      if (seen.has(rawMatch)) continue
      seen.add(rawMatch)

      const numStr = match[1].toLowerCase()
      const unit = match[2]
      const quantity = ENGLISH_NUM_MAP[numStr] ?? parseInt(numStr, 10)

      if (quantity > 1 && quantity <= 20) {
        constraints.push({ raw_match: rawMatch, quantity, unit })
      }
    }
  }

  return constraints
}

/** Completion-class tools and patterns (includes MCP-prefixed variants) */
const COMPLETION_TOOL_NAMES = new Set([
  'track_progress', 'update_task', 'TaskUpdate', 'TaskOutput',
  'mcp__engram__track_progress', 'mcp__engram__update_task',
])

const COMPLETION_KEYWORDS = /交付完成|任务完成|全部完成|已完成|delivery complete|task.?done|completed/i

/**
 * Check if an event represents a completion declaration.
 */
function isCompletionEvent(event: NormalizedEvent): boolean {
  if (COMPLETION_TOOL_NAMES.has(event.tool_name)) return true
  if (event.domain === 'task_mgmt' && event.raw_message) {
    if (COMPLETION_KEYWORDS.test(event.raw_message)) return true
    // track_progress with completion=100 or status=done
    if (/completion.*100|status.*done/i.test(event.raw_message)) return true
  }
  return false
}

/** Output-producing tools — things that CREATE new deliverables (not modify existing) */
const OUTPUT_TOOLS = new Set([
  'Write', 'write',
])

/**
 * Count distinct output artifacts (unique file targets written) up to a given event index.
 */
function countOutputArtifacts(events: NormalizedEvent[], upToIndex: number): number {
  const outputTargets = new Set<string>()

  for (let i = 0; i <= upToIndex; i++) {
    const event = events[i]
    if (OUTPUT_TOOLS.has(event.tool_name) && event.tool_target) {
      // Normalize: group by directory (each article = one directory)
      const dirPath = extractParentDir(event.tool_target)
      outputTargets.add(dirPath)
    }
  }

  return outputTargets.size
}

/**
 * Extract parent directory from a file path.
 * Used to group files into logical output units (e.g., all files in one article folder = 1 artifact).
 */
function extractParentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/')
  if (lastSlash <= 0) return filePath
  return filePath.substring(0, lastSlash)
}

/**
 * Detect completion_coverage_gap signals.
 *
 * @param events - Normalized event stream
 * @param promptText - First user message (the original task prompt)
 * @returns Array of signals (typically 0 or 1)
 */
export function detectCompletionCoverageGap(
  events: NormalizedEvent[],
  promptText: string | undefined,
): CompletionCoverageGapSignal[] {
  if (!promptText) return []

  const constraints = extractQuantityConstraints(promptText)
  if (constraints.length === 0) return []

  // Use the largest quantity constraint as expected count
  const expectedCount = Math.max(...constraints.map(c => c.quantity))

  const signals: CompletionCoverageGapSignal[] = []

  // Find completion events and check coverage
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!isCompletionEvent(event)) continue

    const actualCount = countOutputArtifacts(events, i)

    if (actualCount < expectedCount) {
      signals.push({
        signal: 'completion_coverage_gap',
        completion_event_index: i,
        prompt_constraints: constraints,
        actual_output_count: actualCount,
        expected_output_count: expectedCount,
      })
      // Only report the last (most authoritative) completion event
      break
    }
  }

  return signals
}
