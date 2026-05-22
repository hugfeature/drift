/**
 * TimelineBuilder — generates per-event temporal metrics for trajectory analysis.
 *
 * Transforms a flat event stream into a timeline of sliding-window metrics,
 * enabling temporal pattern recognition (e.g., novelty monotonic decay = rabbit hole).
 *
 * No external dependencies (no embedding, no LLM). Pure behavioral computation.
 */

import type { RuntimeEvent } from '../types/event'
import type { DriftStatus } from '../types/scoring'
import type { SessionTimeline, TimelinePoint } from './types'

export interface TimelineBuilderConfig {
  /** Sliding window size for exploration/progress density */
  windowSize: number
  /** Threshold below which goal_alignment triggers 'drifting' */
  driftingThreshold: number
  /** Threshold below which goal_alignment triggers 'lost' */
  lostThreshold: number
}

const DEFAULT_CONFIG: TimelineBuilderConfig = {
  windowSize: 10,
  driftingThreshold: 0.5,
  lostThreshold: 0.3,
}

export class TimelineBuilder {
  private config: TimelineBuilderConfig

  constructor(config?: Partial<TimelineBuilderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Build a complete session timeline from tool_call events.
   */
  build(sessionId: string, goalText: string, events: RuntimeEvent[]): SessionTimeline {
    const toolEvents = events.filter(e => e.type === 'tool_call')
    const points = this.computePoints(toolEvents)

    const noveltyCollapseAt = points.findIndex(p => p.cumulative_novelty < 0.3)
    const divergenceOnsetAt = points.findIndex(p => p.goal_alignment < 0.5)
    const meanAlignment = points.length > 0
      ? points.reduce((sum, p) => sum + p.goal_alignment, 0) / points.length
      : 1.0
    const finalNovelty = points.length > 0
      ? points[points.length - 1].cumulative_novelty
      : 1.0

    return {
      session_id: sessionId,
      goal: goalText,
      total_events: toolEvents.length,
      points,
      novelty_collapse_at: noveltyCollapseAt >= 0 ? noveltyCollapseAt : undefined,
      divergence_onset_at: divergenceOnsetAt >= 0 ? divergenceOnsetAt : undefined,
      mean_alignment: meanAlignment,
      final_novelty: finalNovelty,
    }
  }

  private computePoints(toolEvents: RuntimeEvent[]): TimelinePoint[] {
    const points: TimelinePoint[] = []
    const seenTargets = new Set<string>()
    let totalWithTarget = 0

    for (let i = 0; i < toolEvents.length; i++) {
      const event = toolEvents[i]
      const toolName = String(event.payload['tool_name'] ?? 'unknown')
      const target = this.extractTarget(event)

      // Cumulative novelty: unique targets / total target-bearing events
      if (target) {
        totalWithTarget++
        seenTargets.add(target)
      }
      const cumulativeNovelty = totalWithTarget > 0
        ? seenTargets.size / totalWithTarget
        : 1.0

      // Sliding window metrics
      const windowStart = Math.max(0, i - this.config.windowSize + 1)
      const window = toolEvents.slice(windowStart, i + 1)
      const explorationDepth = this.computeExplorationDepth(window)
      const progressDensity = this.computeProgressDensity(window)

      // Goal alignment proxy: inverse of exploration stagnation pattern
      // In absence of real embedding per-event, use behavioral proxy:
      // high progress + novelty = aligned; low progress + low novelty = drifting
      const goalAlignment = this.estimateAlignment(cumulativeNovelty, progressDensity, explorationDepth)

      const status = this.classifyStatus(goalAlignment)

      points.push({
        event_index: i,
        timestamp: event.timestamp,
        tool_name: toolName,
        target,
        goal_alignment: goalAlignment,
        cumulative_novelty: cumulativeNovelty,
        exploration_depth: explorationDepth,
        progress_density: progressDensity,
        status,
      })
    }

    return points
  }

  /**
   * Estimate goal alignment from behavioral signals.
   *
   * This is a behavioral proxy — not semantic embedding.
   * The insight: sessions that are making progress (editing new files)
   * are more likely aligned than sessions stuck reading the same files.
   *
   * When real per-event embedding is available, this gets replaced.
   */
  private estimateAlignment(novelty: number, progressDensity: number, explorationDepth: number): number {
    // Novelty contributes 40%: high novelty = exploring purposefully
    // Progress contributes 40%: editing = making changes = aligned
    // Low exploration contributes 20%: not stuck in read loops
    const noveltySignal = Math.min(novelty, 1.0)
    const progressSignal = Math.min(progressDensity * 3, 1.0) // Scale up: 0.33 progress density = full signal
    const explorationPenalty = Math.max(0, explorationDepth - 0.7) // Penalty only when very high

    return Math.max(0, Math.min(1.0,
      noveltySignal * 0.40 +
      progressSignal * 0.40 +
      (1 - explorationPenalty) * 0.20
    ))
  }

  private classifyStatus(alignment: number): DriftStatus {
    if (alignment >= this.config.driftingThreshold) return 'aligned'
    if (alignment >= this.config.lostThreshold) return 'drifting'
    return 'lost'
  }

  private computeExplorationDepth(window: RuntimeEvent[]): number {
    let explorationCount = 0
    for (const event of window) {
      const tool = String(event.payload['tool_name'] ?? '').toLowerCase()
      if (this.isExplorationTool(tool)) explorationCount++
    }
    return explorationCount / window.length
  }

  private computeProgressDensity(window: RuntimeEvent[]): number {
    let progressCount = 0
    for (const event of window) {
      const tool = String(event.payload['tool_name'] ?? '').toLowerCase()
      if (this.isProgressTool(tool)) progressCount++
    }
    return progressCount / window.length
  }

  private isProgressTool(tool: string): boolean {
    return /^(edit|write|save|patch|modify|create|add|new|generate|taskupdate|update_plan)$/.test(tool)
  }

  private isExplorationTool(tool: string): boolean {
    return /^(read|view|cat|grep|glob|ls|bash|exec|shell|run|command|terminal|search|query|web_search|web_fetch|fetch)$/.test(tool)
      || /^mcp__/.test(tool)
  }

  private extractTarget(event: RuntimeEvent): string {
    const payload = event.payload
    const target = payload['target'] as string | undefined
    if (target && this.looksLikeFilePath(target)) return this.normalizePath(target)

    const toolInput = payload['tool_input'] as Record<string, unknown> | undefined
    if (toolInput && toolInput['file_path']) {
      return this.normalizePath(String(toolInput['file_path']))
    }

    const toolName = String(payload['tool_name'] ?? '')
    if (/^mcp__/.test(toolName)) return toolName

    return ''
  }

  private looksLikeFilePath(value: string): boolean {
    return /[/\\]/.test(value) || /\.\w{1,5}$/.test(value)
  }

  private normalizePath(fullPath: string): string {
    const segments = fullPath.split(/[/\\]/).filter(Boolean)
    const homeIdx = segments.findIndex(s => s === 'Users' || s === 'home')
    const meaningful = homeIdx >= 0 ? segments.slice(homeIdx + 2) : segments
    return meaningful.slice(-4).join('/')
  }
}
