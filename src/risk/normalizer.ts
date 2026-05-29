/**
 * Risk Layer v0.1 — Event Normalizer
 * Converts both fixture schemas into NormalizedEvent[].
 * Per RFC §3.1–3.2
 */

import type {
  NormalizedEvent,
  RawFixtureEvent,
  SignalOutcome,
} from './types'
import { mapToolToDomain } from './domain-map'

/** Read-class tools that can serve as refresh operations */
const REFRESH_TOOLS = new Set([
  'Read', 'read', 'Grep', 'Glob',
  'cat', 'stat', 'ls', 'find',
])

const BASH_REFRESH_COMMANDS = /\b(cat|head|tail|less|stat|ls|find|grep|awk)\s/

/**
 * Extract tool_target from payload — best-effort, regex-based.
 * Returns undefined if no target is extractable.
 */
function extractToolTarget(event: RawFixtureEvent): string | undefined {
  const payload = event.payload
  if (!payload) return undefined

  // Try explicit file/path fields
  for (const key of ['file', 'path', 'file_path', 'target', 'url', 'resource']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) {
      return normalizePath(value)
    }
  }

  // Try extracting from message/command
  const text = payload.message || payload.command
  if (typeof text === 'string') {
    return extractPathFromText(text)
  }

  return undefined
}

/** Normalize file paths for consistent comparison */
function normalizePath(filePath: string): string {
  return filePath
    .replace(/^~\//, '/HOME/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
}

/** Best-effort path extraction from command text */
function extractPathFromText(text: string): string | undefined {
  // Match file paths (absolute or relative with extension)
  const pathMatch = text.match(
    /(?:^|\s)((?:~?\/[\w./-]+)|(?:[\w][\w./-]*\.(?:ts|js|json|md|py|go|rs|java|yaml|yml|toml|sh|css|html|tsx|jsx)))/,
  )
  if (pathMatch) {
    return normalizePath(pathMatch[1])
  }
  return undefined
}

/**
 * Determine if an event is a refresh operation for a previously observed target.
 * Per RFC: refresh is valid ONLY when the refresh tool is read-class AND
 * the refresh target overlaps with the previously observed state target.
 */
function isRefreshEvent(
  event: RawFixtureEvent,
  toolName: string,
  toolTarget: string | undefined,
  priorObservationTargets: Set<string>,
): boolean {
  if (!toolTarget || priorObservationTargets.size === 0) return false

  // Check if tool is read-class
  if (REFRESH_TOOLS.has(toolName)) {
    return priorObservationTargets.has(toolTarget)
  }

  // Bash read commands
  if ((toolName === 'Bash' || toolName === 'exec') && event.payload) {
    const text = event.payload.message || event.payload.command
    if (typeof text === 'string' && BASH_REFRESH_COMMANDS.test(text)) {
      return priorObservationTargets.has(toolTarget)
    }
  }

  return false
}

/** Infer outcome from event payload — conservative, defaults to 'unknown' */
function inferOutcome(event: RawFixtureEvent): SignalOutcome {
  const payload = event.payload
  if (!payload) return 'unknown'

  // Check explicit status/result fields
  for (const key of ['status', 'result', 'outcome', 'exit_code']) {
    const value = payload[key]
    if (value === 'success' || value === 0 || value === 'done') return 'success'
    if (value === 'failed' || value === 'error' || value === 1) return 'failed'
  }

  // Check for error indicators in message
  const message = payload.message
  if (typeof message === 'string') {
    if (/\b(error|fail|exception|traceback|ENOENT|EACCES|denied)\b/i.test(message)) {
      return 'failed'
    }
  }

  return 'unknown'
}

/**
 * Normalize a fixture's raw events into NormalizedEvent[].
 * Tracks observation targets for refresh detection.
 */
export function normalizeEvents(rawEvents: RawFixtureEvent[]): NormalizedEvent[] {
  const observationTargets = new Set<string>()
  const normalized: NormalizedEvent[] = []

  for (let index = 0; index < rawEvents.length; index++) {
    const raw = rawEvents[index]
    const toolName = raw.payload?.tool_name ?? 'unknown'
    const payloadMessage =
      (raw.payload?.message as string) ??
      (raw.payload?.command as string) ??
      undefined
    const toolTarget = extractToolTarget(raw)
    const domain = mapToolToDomain(toolName, payloadMessage)

    const isRefresh = isRefreshEvent(raw, toolName, toolTarget, observationTargets)

    // Track read-class targets as observation targets
    if (domain === 'read' && toolTarget) {
      observationTargets.add(toolTarget)
    }

    normalized.push({
      index,
      timestamp: raw.timestamp,
      tool_name: toolName,
      tool_target: toolTarget,
      domain,
      goal_relation: raw.goal_relation as NormalizedEvent['goal_relation'],
      relation_confidence: raw.relation_confidence,
      is_refresh: isRefresh,
      outcome: inferOutcome(raw),
      raw_message: payloadMessage,
    })
  }

  return normalized
}
