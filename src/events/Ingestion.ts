/**
 * EventIngestion: incoming agent event pipeline.
 *
 * Responsibilities:
 *   - Accept raw events from agent adapters (Claude Code, Cursor, etc.)
 *   - Validate and normalize to RuntimeEvent schema
 *   - Attach session_id and goal_id context
 *   - Emit to registered listeners (scorer, narrative engine, etc.)
 *
 * goal_relation is NOT computed here.
 * It is computed lazily by the drift scorer when it processes the event.
 * This keeps ingestion fast and non-blocking.
 */

import type { RuntimeEvent, EventType } from '../types/event'
import type { GoalSource } from '../types/goal'

// Raw input from an agent adapter — intentionally loose.
// Adapters normalize their native formats into this shape.
export interface RawEvent {
  session_id: string
  type: EventType
  source: GoalSource
  payload: Record<string, unknown>
  goal_id?: string
  timestamp?: number             // optional: defaults to Date.now()
}

export type EventListener = (event: RuntimeEvent) => void | Promise<void>

function generateId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function validateRawEvent(raw: RawEvent): void {
  if (!raw.session_id) throw new Error('RawEvent missing session_id')
  if (!raw.type)       throw new Error('RawEvent missing type')
  if (!raw.source)     throw new Error('RawEvent missing source')
}

export class EventIngestion {
  private listeners: EventListener[] = []
  private buffer: RuntimeEvent[] = []

  /**
   * Register a listener to receive every ingested event.
   * Listeners are called in registration order.
   * Async listeners are awaited sequentially.
   */
  onEvent(listener: EventListener): void {
    this.listeners.push(listener)
  }

  /**
   * Ingest a single raw event.
   * Returns the normalized RuntimeEvent.
   */
  async ingest(raw: RawEvent): Promise<RuntimeEvent> {
    validateRawEvent(raw)

    const event: RuntimeEvent = {
      id:         generateId(),
      timestamp:  raw.timestamp ?? Date.now(),
      session_id: raw.session_id,
      type:       raw.type,
      source:     raw.source,
      payload:    raw.payload,
      goal_id:    raw.goal_id,
      // goal_relation intentionally omitted — computed lazily by scorer
    }

    this.buffer.push(event)

    for (const listener of this.listeners) {
      await listener(event)
    }

    return event
  }

  /**
   * Ingest multiple events in order.
   * Useful for replaying a recorded session.
   */
  async ingestBatch(raws: RawEvent[]): Promise<RuntimeEvent[]> {
    const results: RuntimeEvent[] = []
    for (const raw of raws) {
      results.push(await this.ingest(raw))
    }
    return results
  }

  /**
   * Return all ingested events for this ingestion instance.
   * Used by the scorer and narrative engine to access full history.
   */
  getBuffer(): RuntimeEvent[] {
    return [...this.buffer]
  }

  /**
   * Return events for a specific session.
   */
  getSessionEvents(session_id: string): RuntimeEvent[] {
    return this.buffer.filter(e => e.session_id === session_id)
  }

  /**
   * Clear the in-memory buffer.
   * Call after persisting to durable storage.
   */
  clearBuffer(): void {
    this.buffer = []
  }
}
