/**
 * Claude Code hook script.
 *
 * Claude Code calls this after every tool use via the PostToolUse hook.
 * Reads JSON from stdin, feeds into Drift scoring pipeline.
 * Writes status to stderr — never interferes with Claude Code stdout.
 *
 * Configure in .claude/settings.json:
 *   "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command",
 *     "command": "npx ts-node /path/to/drift/scripts/claude-hook.ts" }] }]
 */

import * as fs       from 'fs'
import * as path     from 'path'
import * as readline from 'readline'
import { SessionManager } from '../src/session/manager'

// Files written to project root (where `claude` is run)
const CWD          = process.cwd()
const SESSION_FILE = path.join(CWD, '.drift-session.json')
const STATE_FILE   = path.join(CWD, '.drift-state.json')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoalConfig {
  goal:             string
  allowed_domains?: string[]
}

interface DriftState {
  session_id:  string
  started_at:  number
  goal_id:     string
  event_count: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadGoalConfig(): GoalConfig | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as GoalConfig
  } catch { return null }
}

function loadState(): DriftState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as DriftState
  } catch { return null }
}

function saveState(state: DriftState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function log(msg: string): void {
  process.stderr.write(`[Drift] ${msg}\n`)
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

  // Silent exit if no payload or no goal config
  if (!raw) return
  const goalConfig = loadGoalConfig()
  if (!goalConfig) return

  // Parse hook payload
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch { return }

  const toolName = payload['tool_name'] as string | undefined
  if (!toolName) return

  // ---------------------------------------------------------------------------
  // Restore or create session
  // ---------------------------------------------------------------------------

  const savedState = loadState()

  const session = new SessionManager({
    agent:      'claude-code',
    session_id: savedState?.session_id,
    started_at: savedState?.started_at,
  })

  let state: DriftState

  if (!savedState) {
    // First event in session — create goal
    const goalId = session.setGoal(goalConfig.goal)
    await session.confirmGoal(goalId, {
      observable_targets: [goalConfig.goal],
      allowed_domains:    goalConfig.allowed_domains ?? [],
    })
    state = {
      session_id:  session.session_id,
      started_at:  session.started_at,
      goal_id:     goalId,
      event_count: 0,
    }
    log(`Session started. Goal: "${goalConfig.goal}"`)
  } else {
    state = savedState
  }

  // ---------------------------------------------------------------------------
  // Process event
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Print status
  // ---------------------------------------------------------------------------

  const score  = result.drift_score
  const icon   = score.status === 'aligned' ? '✓'
               : score.status === 'drifting' ? '⚡'
               : '✗'

  log(`${icon} ${score.status.padEnd(8)} score=${score.score.toFixed(2)}  tool=${toolName}  events=${state.event_count}`)

  // Takeover recommendation
  if (result.takeover.recommended) {
    log('')
    log('⚠️  Human Takeover Recommended')
    result.takeover.reasons.forEach((r: string)  => log(`  - ${r}`))
    result.takeover.suggested_actions.forEach((a: string) => log(`  → ${a}`))
    log('')
  }

  // New drift/takeover narrative segments
  for (const seg of result.new_segments) {
    if (seg.category === 'drift' || seg.category === 'takeover') {
      log(seg.summary)
    }
  }
}

// Always exit 0 — never block Claude Code on Drift errors
main().catch(err => {
  process.stderr.write(`[Drift] Hook error: ${err.message}\n`)
  process.exit(0)
})