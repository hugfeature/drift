/**
 * Rabbit Hole Detector — behavioral pathology detection.
 *
 * Rabbit hole is NOT "divergence from goal" — it's "infinite recursion within goal".
 * The agent keeps working on the right thing but never converges.
 *
 * Detection signals (all behavioral, not semantic):
 *   1. target_repetition  — same files/commands hit repeatedly
 *   2. novelty_rate       — rate of new targets appearing decays over time
 *   3. progress_stagnation — Read/Bash increases but Edit decreases
 *
 * These signals are independent of semantic_divergence and operate on
 * execution patterns rather than goal-action similarity.
 */

import type { RuntimeEvent } from '../types/event'
import type { BehavioralPathologySignals } from '../types/scoring'

export interface RabbitHoleConfig {
  /** Window size for behavioral analysis (event count) */
  windowSize: number            // default 30
  /** Minimum events before detection activates */
  minimumEvents: number         // default 15
  /** Threshold for rabbit_hole_score to flag pathology */
  scoreThreshold: number        // default 0.6
}

const DEFAULT_CONFIG: RabbitHoleConfig = {
  windowSize: 30,
  minimumEvents: 15,
  scoreThreshold: 0.55,
}

export class RabbitHoleDetector {
  private config: RabbitHoleConfig

  constructor(config?: Partial<RabbitHoleConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Analyze event stream for rabbit hole behavioral patterns.
   * Returns null if insufficient events for reliable detection.
   */
  detect(events: RuntimeEvent[]): BehavioralPathologySignals | null {
    const toolEvents = events.filter(
      e => e.type === 'tool_call'
    )

    if (toolEvents.length < this.config.minimumEvents) return null

    const window = toolEvents.slice(-this.config.windowSize)

    const targetRepetition = this.computeTargetRepetition(window)
    const noveltyRate = this.computeNoveltyRate(toolEvents)
    const progressStagnation = this.computeProgressStagnation(window)

    // Composite score: weighted combination of behavioral signals
    // Target repetition is strongest indicator (agent stuck on same files)
    // Progress stagnation second (lots of reading, no writing)
    // Novelty decay third (confirmation signal)
    const rabbitHoleScore = Math.min(
      targetRepetition * 0.45 +
      progressStagnation * 0.35 +
      (1 - noveltyRate) * 0.20,
      1.0
    )

    return {
      target_repetition: targetRepetition,
      novelty_rate: noveltyRate,
      progress_stagnation: progressStagnation,
      rabbit_hole_score: rabbitHoleScore,
    }
  }

  /**
   * Target repetition: how concentrated are file operations on a small set?
   *
   * Measures: 1 - (unique_targets / total_target_operations).
   * Only considers events with identifiable file targets (Read/Edit/Write).
   * Bash commands with unique messages are excluded to avoid dilution.
   *
   * rabbit_hole signature: 0.7+ (agent operates on 2-3 files across 30 events)
   * healthy session: 0.0-0.4 (many different files touched)
   */
  private computeTargetRepetition(events: RuntimeEvent[]): number {
    const fileTargets = events
      .map(e => this.extractFileTarget(e))
      .filter(t => t !== '')

    if (fileTargets.length < 3) return 0

    const uniqueTargets = new Set(fileTargets)
    return 1 - (uniqueTargets.size / fileTargets.length)
  }

  /**
   * Novelty rate: in the recent window, how many targets are being seen
   * for the first time vs the entire session history?
   *
   * Early in a session: high novelty (exploring new files).
   * In a rabbit hole: low novelty (re-visiting same files).
   */
  private computeNoveltyRate(allEvents: RuntimeEvent[]): number {
    const windowSize = this.config.windowSize
    const recentEvents = allEvents.slice(-windowSize)
    const priorEvents = allEvents.slice(0, -windowSize)

    // Build set of targets seen before the recent window
    const priorTargets = new Set(
      priorEvents.map(e => this.extractFileTarget(e)).filter(t => t !== '')
    )

    const recentTargets = recentEvents
      .map(e => this.extractFileTarget(e))
      .filter(t => t !== '')

    if (recentTargets.length === 0) return 1.0

    const novelTargets = recentTargets.filter(t => !priorTargets.has(t))
    return novelTargets.length / recentTargets.length
  }

  /**
   * Progress stagnation: ratio of exploration (Read/Bash/Search) to
   * progress (Edit/Write/Create) in the recent window.
   *
   * Healthy session: exploration leads to edits (ratio ~0.3-0.5).
   * Rabbit hole: exploration dominates with few or no edits (ratio ~0.8-1.0).
   */
  private computeProgressStagnation(events: RuntimeEvent[]): number {
    let explorationCount = 0
    let progressCount = 0

    for (const event of events) {
      const rawToolName = String(event.payload['tool_name'] ?? '')
      const toolName = rawToolName.toLowerCase().replace(/^mcp__\w+__/, '')

      if (this.isProgressTool(toolName)) {
        progressCount++
      } else if (this.isExplorationTool(toolName) || /^mcp__/.test(rawToolName.toLowerCase())) {
        explorationCount++
      }
    }

    const total = explorationCount + progressCount
    if (total === 0) return 0

    // If no progress tools at all, max stagnation
    if (progressCount === 0) return 1.0

    // Stagnation = how skewed toward exploration vs progress
    // ratio 5:1 exploration:progress → stagnation ~0.8
    const ratio = explorationCount / progressCount
    return Math.min(ratio / 6, 1.0)
  }

  private isProgressTool(tool: string): boolean {
    return /^(edit|write|save|patch|modify|create|add|new|generate)$/.test(tool)
  }

  private isExplorationTool(tool: string): boolean {
    return /^(read|view|cat|grep|glob|ls|bash|exec|shell|run|command|terminal|search|query|web_search|web_fetch|fetch)$/.test(tool)
  }

  /**
   * Extract a normalized target identifier from an event.
   * Used for repetition/novelty tracking.
   *
   * Falls back to tool_name when no explicit target exists — for MCP tools
   * like `mcp__logsearch__grep_log`, repeated calls to the same
   * tool ARE the repetition signal even without a file target.
   */
  private extractTarget(event: RuntimeEvent): string {
    const payload = event.payload
    const target = payload['target'] as string | undefined
    if (target) return this.normalizePath(target)

    const toolInput = payload['tool_input'] as Record<string, unknown> | undefined
    if (toolInput) {
      if (toolInput['file_path']) return this.normalizePath(String(toolInput['file_path']))
      if (toolInput['command']) return String(toolInput['command']).slice(0, 80)
      if (toolInput['query']) return String(toolInput['query']).slice(0, 80)
    }

    // Fallback: for MCP tools (which have semantically specific names like
    // mcp__logsearch__grep_log), repeated calls to the same tool
    // IS behavioral repetition. But generic tools (Read/Bash/Edit) are too
    // common to use as repetition signal without a distinguishing target.
    const toolName = String(payload['tool_name'] ?? '')
    if (/^mcp__/.test(toolName)) return toolName

    // For generic tools with a message, use tool+message as fingerprint
    const message = String(payload['message'] ?? '').trim()
    if (message && toolName) return `${toolName}:${message.slice(0, 40)}`

    return ''
  }

  /**
   * Extract file-level target only (for target_repetition).
   * Returns empty string for events without a file path (Bash, web_search, etc).
   * This prevents Bash messages from diluting file repetition signal.
   */
  private extractFileTarget(event: RuntimeEvent): string {
    const payload = event.payload
    const target = payload['target'] as string | undefined
    if (target && this.looksLikeFilePath(target)) return this.normalizePath(target)

    const toolInput = payload['tool_input'] as Record<string, unknown> | undefined
    if (toolInput && toolInput['file_path']) {
      return this.normalizePath(String(toolInput['file_path']))
    }

    // MCP tools: use tool name as pseudo-target (repeated MCP calls = repetition)
    const toolName = String(payload['tool_name'] ?? '')
    if (/^mcp__/.test(toolName)) return toolName

    return ''
  }

  private looksLikeFilePath(value: string): boolean {
    return /[/\\]/.test(value) || /\.\w{1,5}$/.test(value)
  }

  /**
   * Normalize file paths to meaningful suffix for comparison.
   * "/Users/x/project/src/auth/login.ts" → "src/auth/login.ts"
   */
  private normalizePath(fullPath: string): string {
    const segments = fullPath.split(/[/\\]/).filter(Boolean)
    const homeIdx = segments.findIndex(s => s === 'Users' || s === 'home')
    const meaningful = homeIdx >= 0 ? segments.slice(homeIdx + 2) : segments
    return meaningful.slice(-4).join('/')
  }
}
