/**
 * Claude Code / CCLI hook script.
 *
 * Handles two hook events:
 *   - UserPromptSubmit: captures user prompt as the active goal (auto goal)
 *   - PostToolUse: scores each tool call against the current goal
 *
 * Goal strategy:
 *   1. Each UserPromptSubmit sets a new goal (the user's actual prompt)
 *   2. Subsequent PostToolUse events are scored against that goal
 *   3. No manual .drift-session.json required (but still supported as override)
 *
 * Configure in settings.json hooks for both UserPromptSubmit and PostToolUse.
 */

import * as fs       from 'fs'
import * as path     from 'path'
import * as readline from 'readline'
import { SessionManager } from '../src/session/manager'

// Files written to project root (where agent is run)
const CWD          = process.cwd()
const HOME         = process.env.HOME || process.env.USERPROFILE || ''
const GLOBAL_SESSION_FILE = path.join(HOME, '.drift-session.json')
const SESSION_FILE = path.join(CWD, '.drift-session.json')
const STATE_FILE   = path.join(CWD, '.drift-state.json')
const EVENTS_FILE  = path.join(CWD, '.drift-events.jsonl')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoalConfig {
  goal:             string
  allowed_domains?: string[]
}

interface DriftState {
  session_id:    string
  started_at:    number
  goal_id:       string
  current_goal:  string        // the actual goal text (from prompt or config)
  event_count:   number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadGoalConfig(): GoalConfig | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as GoalConfig
  } catch {
    try {
      return JSON.parse(fs.readFileSync(GLOBAL_SESSION_FILE, 'utf-8')) as GoalConfig
    } catch { return null }
  }
}

function loadState(): DriftState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as DriftState
  } catch { return null }
}

function saveState(state: DriftState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function appendEvent(entry: Record<string, unknown>): void {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + '\n')
}

function log(msg: string): void {
  process.stderr.write(`[Drift] ${msg}\n`)
}

/**
 * Extract the user's prompt text from a UserPromptSubmit hook payload.
 * Claude Code / CodeFuse sends the prompt in various fields depending on version.
 */
function extractPromptText(payload: Record<string, unknown>): string | null {
  // Try common field names
  const candidates = [
    payload['prompt'],
    payload['message'],
    payload['content'],
    payload['user_prompt'],
    (payload['tool_input'] as Record<string, unknown> | undefined)?.['prompt'],
    (payload['tool_input'] as Record<string, unknown> | undefined)?.['message'],
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim()
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Detect hook event type from CLI args or payload
// ---------------------------------------------------------------------------

function getHookEventType(payload: Record<string, unknown>): 'session_start' | 'user_prompt' | 'tool_call' | 'stop' | 'unknown' {
  // Check CLI args first (--event flag)
  const eventArgIndex = process.argv.indexOf('--event')
  if (eventArgIndex !== -1) {
    const eventType = process.argv[eventArgIndex + 1]
    if (eventType === 'SessionStart') return 'session_start'
    if (eventType === 'Stop') return 'stop'
    if (eventType === 'UserPromptSubmit') return 'user_prompt'
  }

  // Infer from payload content
  if (payload['tool_name']) return 'tool_call'
  if (payload['prompt'] || payload['user_prompt'] || payload['message']) return 'user_prompt'

  return 'unknown'
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read hook payload from stdin
  const rl = readline.createInterface({ input: process.stdin })
  const lines: string[] = []
  for await (const line of rl) lines.push(line)
  const raw = lines.join('\n').trim()

  if (!raw) return

  // Parse hook payload
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch { return }

  const eventType = getHookEventType(payload)

  // ---------------------------------------------------------------------------
  // Handle SessionStart — reset state, start fresh drift session
  // ---------------------------------------------------------------------------

  if (eventType === 'session_start') {
    // Clean previous session state — new Claude Code session = new drift session
    try { fs.unlinkSync(STATE_FILE) } catch { /* no previous state */ }

    log('🔄 New session started (state reset)')

    appendEvent({
      event_index: 0,
      timestamp:   Date.now(),
      event_type:  'session_start',
    })
    return
  }

  // ---------------------------------------------------------------------------
  // Handle Stop — finalize drift session
  // ---------------------------------------------------------------------------

  if (eventType === 'stop') {
    const savedState = loadState()
    if (savedState) {
      appendEvent({
        event_index: savedState.event_count + 1,
        timestamp:   Date.now(),
        event_type:  'session_stop',
        goal:        savedState.current_goal,
        total_events: savedState.event_count,
      })
      log(`🛑 Session ended. ${savedState.event_count} events scored.`)
    }
    return
  }

  // ---------------------------------------------------------------------------
  // Handle UserPromptSubmit — set new goal from user's prompt
  // ---------------------------------------------------------------------------

  if (eventType === 'user_prompt') {
    const promptText = extractPromptText(payload)
    if (!promptText) return

    // Truncate very long prompts to first meaningful sentence for goal
    const goalText = promptText.length > 300
      ? promptText.slice(0, 300).replace(/\s+\S*$/, '...')
      : promptText

    const savedState = loadState()

    const session = new SessionManager({
      agent:      'claude-code',
      session_id: savedState?.session_id,
      started_at: savedState?.started_at,
    })

    // Create new goal from prompt
    const goalId = session.setGoal(goalText)
    await session.confirmGoal(goalId, {
      observable_targets: [goalText],
      allowed_domains:    [],
    })

    const state: DriftState = {
      session_id:   session.session_id,
      started_at:   session.started_at,
      goal_id:      goalId,
      current_goal: goalText,
      event_count:  savedState?.event_count ?? 0,
    }
    saveState(state)

    // Log goal change
    appendEvent({
      event_index: state.event_count,
      timestamp:   Date.now(),
      event_type:  'goal_set',
      goal:        goalText,
    })

    log(`🎯 Goal set: "${goalText.slice(0, 80)}${goalText.length > 80 ? '...' : ''}"`)
    return
  }

  // ---------------------------------------------------------------------------
  // Handle PostToolUse — score tool call against current goal
  // ---------------------------------------------------------------------------

  if (eventType !== 'tool_call') return

  const toolName = payload['tool_name'] as string | undefined
  if (!toolName) return

  // Load state — need an active goal to score against
  const savedState = loadState()

  // If no state exists yet, try to bootstrap from .drift-session.json
  if (!savedState) {
    const goalConfig = loadGoalConfig()
    if (!goalConfig) return  // no goal at all — can't score

    const session = new SessionManager({ agent: 'claude-code' })
    const goalId = session.setGoal(goalConfig.goal)
    await session.confirmGoal(goalId, {
      observable_targets: [goalConfig.goal],
      allowed_domains:    goalConfig.allowed_domains ?? [],
    })

    const state: DriftState = {
      session_id:   session.session_id,
      started_at:   session.started_at,
      goal_id:      goalId,
      current_goal: goalConfig.goal,
      event_count:  0,
    }
    saveState(state)
    log(`Session started (from config). Goal: "${goalConfig.goal}"`)
  }

  const state = loadState()!

  const session = new SessionManager({
    agent:      'claude-code',
    session_id: state.session_id,
    started_at: state.started_at,
  })

  // Re-register goal on the session manager (it doesn't persist across processes)
  const goalId = session.setGoal(state.current_goal)
  await session.confirmGoal(goalId, {
    observable_targets: [state.current_goal],
    allowed_domains:    [],
  })

  // Process the tool call event
  const result = await session.processEvent({
    type:   'tool_call',
    source: 'agent',
    payload: {
      tool_name:     toolName,
      tool_input:    payload['tool_input'],
      tool_response: payload['tool_result'] ?? payload['tool_response'],
      message:       payload['message'],
    },
  })

  state.event_count++
  saveState(state)

  // Append full event to .drift-events.jsonl
  appendEvent({
    event_index:  state.event_count,
    timestamp:    Date.now(),
    event_type:   'tool_call',
    tool_name:    toolName,
    tool_input:   payload['tool_input'],
    tool_result:  payload['tool_result'] ?? payload['tool_response'],
    message:      payload['message'],
    goal:         state.current_goal,
    drift_score:  result.drift_score.score,
    status:       result.drift_score.status,
    takeover:     result.takeover.recommended,
  })

  // ---------------------------------------------------------------------------
  // Print status
  // ---------------------------------------------------------------------------

  const score  = result.drift_score
  const icon   = score.status === 'aligned' ? '✓'
               : score.status === 'drifting' ? '⚡'
               : '✗'

  log(`${icon} ${score.status.padEnd(8)} score=${score.score.toFixed(2)}  tool=${toolName}  events=${state.event_count}`)

  if (result.takeover.recommended) {
    log('')
    log('⚠️  Human Takeover Recommended')
    result.takeover.reasons.forEach((r: string)  => log(`  - ${r}`))
    result.takeover.suggested_actions.forEach((a: string) => log(`  → ${a}`))
    log('')
  }

  for (const seg of result.new_segments) {
    if (seg.category === 'drift' || seg.category === 'takeover') {
      log(seg.summary)
    }
  }
}

// Always exit 0 — never block the agent on Drift errors
main().catch(err => {
  process.stderr.write(`[Drift] Hook error: ${err.message}\n`)
  process.exit(0)
})