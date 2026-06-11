/**
 * repair_cycle_density detector — cleanup spiral detection
 * 
 * Detects agents stuck in edit→test→fail→edit loops on the same file(s).
 * The agent keeps "fixing" problems it introduced, never converging.
 * This is the "no circuit breaker" anti-pattern.
 *
 * Detection logic:
 * 1. Scan event stream for edit tools (file_replace, str_replace, Edit, etc.)
 * 2. Group edits by target file
 * 3. If the same file is edited 3+ times with shell/Bash executions interleaved
 *    (compile/test cycles), fire the signal
 *
 * This signal is deliberately NOT in the zero-FP cognitive-hit whitelist.
 * It feeds the v0.1 execution-layer score via the composite scorer as an
 * additional behavioral signal alongside rabbit_hole detection.
 */

import type { NormalizedEvent } from '../types'

export interface RepairCycleSignal {
  signal: 'repair_cycle_density'
  /** File path that was repeatedly repaired */
  target_file: string
  /** Number of times this file was edited */
  edit_count: number
  /** Number of interleaved shell/test executions between edits */
  interleaved_executions: number
  /** Index of the first edit in the cycle */
  first_edit_index: number
  /** Index of the last edit in the cycle */
  last_edit_index: number
}

const EDIT_TOOLS = new Set([
  'file_replace', 'str_replace', 'Edit', 'edit', 'apply_patch',
  'str_replace_editor', 'replace_in_file',
])

const EXECUTION_TOOLS = new Set([
  'Bash', 'bash', 'shell', 'execute_command', 'run_command',
  'terminal', 'RunCommand',
])

/**
 * Minimum number of edits to the same file to qualify as a repair cycle.
 * 3 = initial edit + 2 repair attempts. Below this, it's plausibly normal iteration.
 */
const MIN_EDIT_COUNT = 3

/**
 * Minimum number of interleaved execution events (compile/test) between edits
 * to distinguish repair cycles from normal multi-part edits.
 * A repair cycle always has test/compile steps between edits (that's the "cycle").
 */
const MIN_INTERLEAVED_EXECUTIONS = 2

/**
 * Detect repair cycle density signals across the event stream.
 *
 * @returns Array of signals, one per file that exhibits a repair cycle pattern
 */
export function detectRepairCycle(events: NormalizedEvent[]): RepairCycleSignal[] {
  const signals: RepairCycleSignal[] = []

  // Track per-file edit history: [eventIndex, ...]
  const fileEditIndices = new Map<string, number[]>()

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (EDIT_TOOLS.has(event.tool_name) && event.tool_target) {
      const target = normalizeFilePath(event.tool_target)
      const indices = fileEditIndices.get(target) ?? []
      indices.push(i)
      fileEditIndices.set(target, indices)
    }
  }

  // For each file edited multiple times, check for interleaved execution events
  for (const [targetFile, editIndices] of fileEditIndices) {
    if (editIndices.length < MIN_EDIT_COUNT) continue

    // Count execution events between the first and last edit of this file
    const firstEdit = editIndices[0]
    const lastEdit = editIndices[editIndices.length - 1]

    let interleavedExecutions = 0
    for (let i = firstEdit + 1; i < lastEdit; i++) {
      if (EXECUTION_TOOLS.has(events[i].tool_name)) {
        interleavedExecutions++
      }
    }

    if (interleavedExecutions >= MIN_INTERLEAVED_EXECUTIONS) {
      signals.push({
        signal: 'repair_cycle_density',
        target_file: targetFile,
        edit_count: editIndices.length,
        interleaved_executions: interleavedExecutions,
        first_edit_index: firstEdit,
        last_edit_index: lastEdit,
      })
    }
  }

  return signals
}

/**
 * Compute a normalized repair cycle score for the entire session.
 * Returns 0.0 (no cycles) to 1.0 (severe repair spiral).
 *
 * Used by the v0.1 execution-layer scorer as an additional signal dimension.
 */
export function computeRepairCycleScore(events: NormalizedEvent[]): number {
  const cycles = detectRepairCycle(events)
  if (cycles.length === 0) return 0

  // Score based on the worst cycle: more edits + more executions = worse
  const worstCycle = cycles.reduce((worst, cycle) => {
    const severity = cycle.edit_count + cycle.interleaved_executions
    const worstSeverity = worst.edit_count + worst.interleaved_executions
    return severity > worstSeverity ? cycle : worst
  })

  // 3 edits + 2 executions (minimum) = 5 → score ~0.3
  // 5 edits + 5 executions = 10 → score ~0.7
  // 8+ edits + 8+ executions = 16+ → score ~1.0
  const rawScore = (worstCycle.edit_count + worstCycle.interleaved_executions - 4) / 12
  return Math.max(0, Math.min(rawScore, 1.0))
}

/**
 * Normalize file path for deduplication.
 * Strips leading ./ and normalizes path separators.
 */
function normalizeFilePath(filePath: string): string {
  return filePath.replace(/^\.\//, '').replace(/\\/g, '/')
}
