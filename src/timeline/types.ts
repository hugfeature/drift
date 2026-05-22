/**
 * Timeline types for temporal drift trajectory analysis.
 *
 * A timeline captures how drift signals evolve over the course of a session,
 * enabling trajectory-level diagnosis rather than snapshot-level scoring.
 *
 * Key insight: rabbit_hole looks like "divergence flat but novelty monotonically
 * decreasing", while scope_expansion looks like "divergence step-jumps".
 * These temporal signatures are more robust than single-point thresholds.
 */

import type { DriftStatus } from '../types/scoring'

/**
 * A single point in the session timeline.
 * One TimelinePoint per tool_call event.
 */
export interface TimelinePoint {
  /** Sequential index in the tool_call stream (0-based) */
  event_index: number
  /** Unix timestamp of this event */
  timestamp: number
  /** Tool that was called */
  tool_name: string
  /** Normalized file/resource target (empty if none) */
  target: string

  // ── Temporal metrics (computed over sliding window) ──

  /**
   * Goal alignment at this point (inverse of semantic_divergence).
   * 1.0 = perfectly aligned, 0.0 = completely unrelated.
   * Computed as 1 - divergence for the window ending at this event.
   */
  goal_alignment: number

  /**
   * Cumulative novelty: unique_targets_so_far / total_events_so_far.
   * Starts at 1.0 (first event is always novel), decreases as session
   * revisits targets. Monotonic decrease = rabbit hole signature.
   */
  cumulative_novelty: number

  /**
   * Exploration density in sliding window:
   * (Read + Bash + Search) / window_size.
   * High and sustained = stagnation. Dropping toward 0 = progress phase.
   */
  exploration_depth: number

  /**
   * Progress density in sliding window:
   * (Edit + Write + Create) / window_size.
   * Healthy sessions show bursts of progress after exploration.
   */
  progress_density: number

  /**
   * Drift status classification at this point.
   * Derived from cumulative signals up to this event.
   */
  status: DriftStatus
}

/**
 * Complete timeline for a session.
 * Output as a single JSON file per session.
 */
export interface SessionTimeline {
  /** Session identifier */
  session_id: string
  /** Goal text (raw) */
  goal: string
  /** Total tool_call events in session */
  total_events: number
  /** Timeline data points */
  points: TimelinePoint[]

  // ── Summary statistics ──

  /** Event index where novelty first drops below 0.3 (rabbit hole onset) */
  novelty_collapse_at?: number
  /** Event index where goal_alignment first drops below 0.5 */
  divergence_onset_at?: number
  /** Average goal alignment across entire session */
  mean_alignment: number
  /** Final cumulative novelty (lower = more repetitive) */
  final_novelty: number
}
