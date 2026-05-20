/**
 * Anonymize a raw Drift session for public contribution.
 *
 * Removes:
 *   - Full file paths (replaces with relative/generic paths)
 *   - User home directory references
 *   - Code content / stdout / tool_input bodies
 *   - Any string matching common sensitive patterns (API keys, tokens)
 *
 * Preserves:
 *   - Session structure (events, goals, timestamps)
 *   - Tool names
 *   - Message descriptions (sanitized)
 *   - Goal text
 *   - Drift scores and relations
 *   - Timing relationships
 *
 * Usage:
 *   npx ts-node scripts/anonymize-session.ts <input.json> [output.json]
 *
 * If output is omitted, writes to <input>_anonymized.json
 */

import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Sensitive patterns
// ---------------------------------------------------------------------------

const HOME_DIR_PATTERN = /\/Users\/[^/\s"']+|\/home\/[^/\s"']+|C:\\Users\\[^\\\s"']+/g
const ABSOLUTE_PATH_PATTERN = /(?:\/[\w.-]+){3,}/g
const API_KEY_PATTERN = /(?:sk-|ghp_|gho_|Bearer\s+)[a-zA-Z0-9_-]{20,}/g
const EMAIL_PATTERN = /[\w.-]+@[\w.-]+\.\w{2,}/g
const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g

// Internal/corporate domain patterns to redact
const INTERNAL_DOMAIN_PATTERN = /(?:alibaba|alipay|antfin|taobao|alicdn|aliyun|dingtalk|1688)(?:-inc)?\.com/gi
const INTERNAL_BRAND_PATTERN = /\b(?:Alipay|AliPay|Alibaba|AntFin|Taobao|DingTalk)\b/g
const INTERNAL_URL_PATTERN = /https?:\/\/[\w.-]*(?:alibaba|alipay|antfin|taobao|alicdn|aliyun|dingtalk|1688)[^"'\s]*/gi

// --- Enhanced: personal identity (no \b for Chinese) ---
const PERSONAL_ID_PATTERN = /wangzhaoxian|探渊|503175/g
const GITHUB_USER_PATTERN = /hugfeature/g

// --- Enhanced: internal project names ---
const INTERNAL_PROJECT_OPENCLAW = /openclaw|OpenClaw|open-claw/gi
const INTERNAL_PROJECT_DITING = /谛听|diting|project-diting/gi
const INTERNAL_PROJECT_ENGRAM = /engram|mcp-engram/gi
const INTERNAL_PROJECT_CODE_PATTERN = /pbc-[a-z0-9]+/gi
const INTERNAL_PROJECT_OBSERV = /\bobserv(?:mcp)?\b/gi

// --- Enhanced: service names in message context (no \b for Chinese) ---
const SERVICE_NAME_IN_MSG = /alipay|dingtalk|钉钉/gi

interface AnonymizeOptions {
  /** Keep the last N path segments (default: 2) */
  keepPathSegments: number
  /** Preserve goal text as-is (default: true — goals are usually non-sensitive) */
  preserveGoalText: boolean
  /** Shift all timestamps to start from T=0 (default: true) */
  normalizeTimestamps: boolean
}

const DEFAULT_OPTIONS: AnonymizeOptions = {
  keepPathSegments: 2,
  preserveGoalText: true,
  normalizeTimestamps: true,
}

// ---------------------------------------------------------------------------
// Path anonymization
// ---------------------------------------------------------------------------

function anonymizePath(filepath: string, keepSegments: number): string {
  const segments = filepath.split(/[/\\]/).filter(Boolean)
  if (segments.length <= keepSegments) return filepath

  const kept = segments.slice(-keepSegments)
  // Remove file extension info that might leak project structure
  return kept.join('/')
}

function sanitizeText(text: string, options: AnonymizeOptions): string {
  let result = text

  // Remove API keys and tokens first
  result = result.replace(API_KEY_PATTERN, '[REDACTED_KEY]')
  result = result.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
  result = result.replace(IP_PATTERN, '[REDACTED_IP]')

  // Remove internal URLs and domains
  result = result.replace(INTERNAL_URL_PATTERN, '[REDACTED_INTERNAL_URL]')
  result = result.replace(INTERNAL_DOMAIN_PATTERN, '[internal].com')
  result = result.replace(INTERNAL_BRAND_PATTERN, '[InternalCo]')

  // Enhanced: personal identity
  result = result.replace(PERSONAL_ID_PATTERN, 'user_001')
  result = result.replace(GITHUB_USER_PATTERN, 'anon-dev')

  // Enhanced: internal project names
  result = result.replace(INTERNAL_PROJECT_OPENCLAW, 'agent-system')
  result = result.replace(INTERNAL_PROJECT_DITING, 'monitor-system')
  result = result.replace(INTERNAL_PROJECT_ENGRAM, 'memory-service')
  result = result.replace(INTERNAL_PROJECT_CODE_PATTERN, 'project-xxx')
  result = result.replace(INTERNAL_PROJECT_OBSERV, 'obs-tool')

  // Enhanced: service names in message context
  result = result.replace(SERVICE_NAME_IN_MSG, '[redacted-service]')

  // Anonymize home directories
  result = result.replace(HOME_DIR_PATTERN, '/~')

  // Anonymize absolute paths but keep last N segments
  result = result.replace(ABSOLUTE_PATH_PATTERN, (match) => {
    return anonymizePath(match, options.keepPathSegments)
  })

  return result
}

// ---------------------------------------------------------------------------
// Session anonymization
// ---------------------------------------------------------------------------

function anonymizePayload(
  payload: Record<string, unknown>,
  options: AnonymizeOptions
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'tool_name') {
      // Sanitize tool names that contain internal project references
      result[key] = sanitizeText(String(value), options)
      continue
    }

    if (key === 'tool_input') {
      // Remove raw tool input (contains code, commands with paths)
      result[key] = '[REDACTED]'
      continue
    }

    if (key === 'tool_response') {
      // Remove stdout/stderr (contains code output)
      result[key] = typeof value === 'object' && value !== null
        ? { redacted: true, had_error: 'error' in (value as Record<string, unknown>) }
        : '[REDACTED]'
      continue
    }

    if (key === 'target' && typeof value === 'string') {
      // Sanitize sensitive names first, then anonymize path
      const sanitizedTarget = sanitizeText(value, options)
      result[key] = anonymizePath(sanitizedTarget, options.keepPathSegments)
      continue
    }

    if (key === 'message' && typeof value === 'string') {
      result[key] = sanitizeText(value, options)
      continue
    }

    // Default: sanitize strings, recurse objects, pass through others
    if (typeof value === 'string') {
      result[key] = sanitizeText(value, options)
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string' ? sanitizeText(item, options) : item
      )
    } else if (typeof value === 'object' && value !== null) {
      result[key] = anonymizePayload(value as Record<string, unknown>, options)
    } else {
      result[key] = value
    }
  }

  return result
}

function anonymizeSession(raw: any, options: AnonymizeOptions): any {
  const session = JSON.parse(JSON.stringify(raw)) // deep clone

  const timeOffset = options.normalizeTimestamps ? session.session.started_at : 0

  // Anonymize session metadata
  const fixtureHash = Math.random().toString(36).slice(2, 10)
  session.id = `fixture_${fixtureHash}`
  if (session.description) {
    session.description = sanitizeText(session.description, options)
  }
  if (session.created_at && options.normalizeTimestamps) {
    session.created_at = session.created_at - timeOffset
  }

  // Anonymize session-level fields
  const sess = session.session

  // Generate a stable anonymized session_id from original (deterministic per run)
  const origSessionId = sess.id || ''
  const anonSessionId = `sess_${origSessionId.replace(/[^a-f0-9-]/g, '').slice(0, 8) || fixtureHash}`
  sess.id = anonSessionId

  // Replace session_id in all events
  for (const event of sess.events || []) {
    if (event.session_id) {
      event.session_id = anonSessionId
    }
  }

  if (options.normalizeTimestamps) {
    sess.started_at = 0
  }

  // Anonymize goals
  for (const goal of sess.goals || []) {
    if (options.normalizeTimestamps) {
      goal.created_at = goal.created_at - timeOffset
    }
    // Always sanitize goal text for sensitive patterns (personal/project names)
    // even when preserveGoalText is true — preserveGoalText only skips generic path anonymization
    goal.raw = sanitizeText(goal.raw, options)
    // Keep normalized structure but sanitize targets and domains
    if (goal.normalized?.observable_targets) {
      goal.normalized.observable_targets = goal.normalized.observable_targets.map(
        (t: string) => sanitizeText(t, options)
      )
    }
    if (goal.normalized?.allowed_domains) {
      goal.normalized.allowed_domains = goal.normalized.allowed_domains.map(
        (d: string) => sanitizeText(d, options)
      )
    }
  }

  // Anonymize events
  for (const event of sess.events || []) {
    if (options.normalizeTimestamps) {
      event.timestamp = event.timestamp - timeOffset
    }
    if (event.payload) {
      event.payload = anonymizePayload(event.payload, options)
    }
    // Sanitize all top-level string fields on events (e.g. _turn_prompt, description)
    for (const key of Object.keys(event)) {
      if (key === 'payload' || key === 'id' || key === 'session_id' || key === 'type' || key === 'source') continue
      if (typeof event[key] === 'string') {
        event[key] = sanitizeText(event[key], options)
      }
    }
  }

  // Anonymize label if present
  if (session.label) {
    if (session.label.drift_started_at && options.normalizeTimestamps) {
      session.label.drift_started_at = session.label.drift_started_at - timeOffset
    }
    if (session.label.goal_forgotten_at && options.normalizeTimestamps) {
      session.label.goal_forgotten_at = session.label.goal_forgotten_at - timeOffset
    }
  }

  // Remove source field that might identify contributor
  delete session.source

  return session
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log(`
Usage: npx ts-node scripts/anonymize-session.ts <input.json> [output.json]

Anonymizes a Drift session JSON for public contribution.
Removes file paths, code content, API keys, and personal identifiers.
Preserves session structure, tool names, timing, and drift scores.

Options (via env vars):
  DRIFT_KEEP_SEGMENTS=2     Path segments to preserve (default: 2)
  DRIFT_PRESERVE_GOAL=true  Keep goal text as-is (default: true)
  DRIFT_NORMALIZE_TIME=true Shift timestamps to T=0 (default: true)
`)
    process.exit(0)
  }

  const inputFile = path.resolve(args[0])
  const outputFile = args[1]
    ? path.resolve(args[1])
    : inputFile.replace(/\.json$/, '_anonymized.json')

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: File not found: ${inputFile}`)
    process.exit(1)
  }

  const options: AnonymizeOptions = {
    keepPathSegments: parseInt(process.env.DRIFT_KEEP_SEGMENTS || '2', 10),
    preserveGoalText: process.env.DRIFT_PRESERVE_GOAL !== 'false',
    normalizeTimestamps: process.env.DRIFT_NORMALIZE_TIME !== 'false',
  }

  const raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'))
  const anonymized = anonymizeSession(raw, options)

  fs.writeFileSync(outputFile, JSON.stringify(anonymized, null, 2))

  const eventCount = anonymized.session?.events?.length ?? 0
  const goalText = anonymized.session?.goals?.[0]?.raw ?? 'unknown'

  console.log(`\n✓ Anonymized session saved: ${outputFile}`)
  console.log(`  Events: ${eventCount}`)
  console.log(`  Goal: "${goalText}"`)
  console.log(`  Timestamps: ${options.normalizeTimestamps ? 'normalized to T=0' : 'preserved'}`)
  console.log(`\nNext: npx ts-node scripts/contribute.ts ${outputFile}`)
}

main()
