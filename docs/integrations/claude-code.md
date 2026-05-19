# Claude Code Integration

Connect Drift to a real Claude Code session in 3 steps.

---

## How It Works

Claude Code has a hooks system. You configure scripts that run on every tool call. Drift's Claude Code adapter reads these hook events and feeds them into the scoring pipeline.

```
Claude Code (running in your terminal)
    ↓  PostToolUse hook fires on every tool call
hook-server.ts (receives JSON event)
    ↓
ClaudeCodeAdapter → EventIngestion → DriftScorer
    ↓
Drift score + Takeover recommendation printed to terminal
```

---

## Step 1: Configure Claude Code Hooks

Create or edit `.claude/settings.json` in your project root:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "npx ts-node /path/to/drift/scripts/claude-hook.ts"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx ts-node /path/to/drift/scripts/claude-hook.ts --event Stop"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/drift` with the absolute path to your Drift installation.

---

## Step 2: Set Your Goal

Before starting Claude Code, set the session goal:

```bash
# In your project directory
DRIFT_GOAL="fix the login bug in auth.ts" npm run drift:start
```

Or create a `.drift-session` file in your project root:

```json
{
  "goal": "fix the login bug in auth.ts",
  "allowed_domains": ["auth", "login", "session", "oauth"]
}
```

---

## Step 3: Run Claude Code Normally

```bash
claude
```

Drift runs in the background. After each tool call, you'll see drift status in a separate terminal pane (or in the hook output if Claude Code shows hook stderr).

---

## Hook Script

Save this as `scripts/claude-hook.ts` in the Drift repo:

```typescript
/**
 * Claude Code hook script.
 * Claude Code calls this after every tool use.
 * Reads JSON from stdin, feeds to Drift pipeline.
 *
 * Usage (via .claude/settings.json hooks config):
 *   "command": "npx ts-node scripts/claude-hook.ts"
 */

import * as fs   from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { SessionManager }    from '../src/session/manager'
import { ClaudeCodeAdapter } from '../src/adapters/claude-code'

const SESSION_FILE = path.join(process.cwd(), '.drift-session.json')
const STATE_FILE   = path.join(process.cwd(), '.drift-state.json')

// ---------------------------------------------------------------------------
// Load or initialize session state
// ---------------------------------------------------------------------------

interface DriftState {
  session_id:    string
  started_at:    number
  goal_id:       string | null
  event_count:   number
}

function loadState(): DriftState | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8')
    return JSON.parse(raw) as DriftState
  } catch {
    return null
  }
}

function saveState(state: DriftState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function loadGoalConfig(): { goal: string; allowed_domains?: string[] } | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read hook payload from stdin
  const rl = readline.createInterface({ input: process.stdin })
  const lines: string[] = []
  for await (const line of rl) {
    lines.push(line)
  }
  const rawInput = lines.join('\n').trim()

  if (!rawInput) return

  // Load goal config
  const goalConfig = loadGoalConfig()
  if (!goalConfig) {
    // No .drift-session file — silent exit, don't interfere with Claude Code
    return
  }

  // Restore or create session
  let state = loadState()
  const session = new SessionManager({
    agent:      'claude-code',
    session_id: state?.session_id,
    started_at: state?.started_at,
  })

  // Register goal if new session
  if (!state) {
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
  }

  // Process the incoming hook event
  const adapter = new ClaudeCodeAdapter(
    // We can't pass ingestion directly here since SessionManager encapsulates it.
    // Instead use processEvent on the session directly.
    null as any,
    session.session_id,
  )

  // Parse the hook payload manually
  let hookPayload: Record<string, unknown>
  try {
    hookPayload = JSON.parse(rawInput)
  } catch {
    return  // not JSON, ignore
  }

  const toolName   = hookPayload['tool_name'] as string | undefined
  const toolInput  = hookPayload['tool_input']
  const toolResult = hookPayload['tool_result'] ?? hookPayload['tool_response']
  const message    = hookPayload['message'] as string | undefined

  if (!toolName) return

  // Feed into session
  const result = await session.processEvent({
    type:   'tool_call',
    source: 'agent',
    payload: {
      tool_name:     toolName,
      tool_input:    toolInput,
      tool_response: toolResult,
      message,
    },
  })

  state.event_count++
  saveState(state)

  // ---------------------------------------------------------------------------
  // Output to stderr (visible in Claude Code hook output, doesn't pollute stdout)
  // ---------------------------------------------------------------------------

  const score  = result.drift_score
  const status = score.status
  const icon   = status === 'aligned' ? '✓' : status === 'drifting' ? '⚡' : '✗'

  process.stderr.write(
    `\n[Drift] ${icon} ${status}  score=${score.score.toFixed(2)}  ` +
    `tool=${toolName}  events=${state.event_count}\n`
  )

  // Print takeover recommendation if triggered
  if (result.takeover.recommended) {
    process.stderr.write('\n[Drift] ⚠️  Human Takeover Recommended\n')
    result.takeover.reasons.forEach((r: string) => {
      process.stderr.write(`[Drift]   - ${r}\n`)
    })
    result.takeover.suggested_actions.forEach((a: string) => {
      process.stderr.write(`[Drift]   → ${a}\n`)
    })
    process.stderr.write('\n')
  }

  // Print new narrative segments
  for (const seg of result.new_segments) {
    if (seg.category === 'drift' || seg.category === 'takeover') {
      process.stderr.write(`[Drift] ${seg.summary}\n`)
    }
  }
}

main().catch(err => {
  process.stderr.write(`[Drift] Hook error: ${err.message}\n`)
  process.exit(0)  // always exit 0 — never block Claude Code
})
```

---

## What You'll See

As Claude Code runs, each tool call prints to stderr:

```
[Drift] ✓ aligned  score=0.12  tool=read_file  events=1
[Drift] ✓ aligned  score=0.24  tool=edit_file  events=2
[Drift] ⚡ drifting  score=0.53  tool=bash  events=5

[Drift] ⚠️  Human Takeover Recommended
[Drift]   - Tool usage entropy critically high for 3+ consecutive evaluations
[Drift]   → Verify agent has not lost focus
```

---

## Collect Real Session Data

Every session creates `.drift-state.json` with the full event stream. To contribute to the eval benchmark:

1. Run a real Claude Code session with Drift connected
2. Annotate it honestly: did drift happen? where? what type?
3. Format it as an `EvalFixture` (see `eval/fixtures/case_001.json` for reference)
4. Open a PR

Real sessions only. Synthetic traces not accepted.

---

## Session Commands

```bash
# Start a new session (clear previous state)
npm run drift:reset

# Print current session narrative
npm run drift:narrative

# Run eval on collected fixtures
npm run eval
```

Add these to `package.json` scripts:

```json
{
  "scripts": {
    "drift:start":     "ts-node scripts/drift-start.ts",
    "drift:reset":     "rm -f .drift-state.json && echo 'Session reset.'",
    "drift:narrative": "ts-node scripts/drift-narrative.ts"
  }
}
```

---

## Troubleshooting

**Hook not firing:** Check `.claude/settings.json` path and ensure `matcher: "*"` covers the tools you're using.

**Goal not loading:** Confirm `.drift-session.json` exists in the project root where you run `claude`.

**Hook exits with error:** Hook script always exits 0 — it will never block Claude Code. Check stderr for `[Drift] Hook error:` messages.

**Score always 0:** The session may not have a confirmed goal. Run `npm run drift:start` before starting Claude Code.