/**
 * Claude Code adapter.
 *
 * Maps Claude Code's native event/hook format into Drift's RawEvent schema.
 *
 * Claude Code emits structured JSON to stdout when hooks are configured.
 * Reference: https://docs.anthropic.com/en/docs/claude-code/hooks
 *
 * Supported Claude Code event types:
 *   PreToolUse     → tool_call (before execution)
 *   PostToolUse    → tool_call (after execution, includes result)
 *   Notification   → subgoal_created or ignored
 *   Stop           → session boundary signal
 *
 * Usage:
 *   const adapter = new ClaudeCodeAdapter(ingestion, session_id)
 *   adapter.processLine(rawJsonLine)  // call for each stdout line
 */

import type { RawEvent } from '../events/ingestion'
import type { EventType } from '../types/event'
import { EventIngestion } from '../events/ingestion'

// Claude Code native hook payload shape (partial)
interface ClaudeCodeHookEvent {
  type: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop'
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  message?: string
  timestamp?: number
}

function mapClaudeEventType(ccType: ClaudeCodeHookEvent['type']): EventType | null {
  switch (ccType) {
    case 'PreToolUse':
    case 'PostToolUse':
      return 'tool_call'
    case 'Notification':
      return 'subgoal_created'
    case 'Stop':
      return null  // session boundary — handled separately
    default:
      return null
  }
}

export class ClaudeCodeAdapter {
  private ingestion: EventIngestion
  private session_id: string
  private active_goal_id?: string

  constructor(ingestion: EventIngestion, session_id: string) {
    this.ingestion = ingestion
    this.session_id = session_id
  }

  /**
   * Set the current active goal id.
   * Events ingested after this call will have goal_id attached.
   */
  setGoalId(goal_id: string): void {
    this.active_goal_id = goal_id
  }

  /**
   * Process a single line of Claude Code JSON output.
   * Non-JSON lines and unknown event types are silently skipped.
   *
   * Returns the ingested RawEvent, or null if the line was skipped.
   */
  async processLine(line: string): Promise<RawEvent | null> {
    let parsed: ClaudeCodeHookEvent

    try {
      parsed = JSON.parse(line.trim()) as ClaudeCodeHookEvent
    } catch {
      return null  // not JSON, skip
    }

    const eventType = mapClaudeEventType(parsed.type)
    if (!eventType) return null

    const raw: RawEvent = {
      session_id: this.session_id,
      type:       eventType,
      source:     'agent',
      goal_id:    this.active_goal_id,
      timestamp:  parsed.timestamp,
      payload: {
        claude_event_type: parsed.type,
        tool_name:         parsed.tool_name,
        tool_input:        parsed.tool_input,
        tool_response:     parsed.tool_response,
        message:           parsed.message,
      },
    }

    await this.ingestion.ingest(raw)
    return raw
  }

  /**
   * Process multiple lines at once (e.g. from a file or buffer).
   */
  async processLines(lines: string[]): Promise<Array<RawEvent | null>> {
    return Promise.all(lines.map(line => this.processLine(line)))
  }
}