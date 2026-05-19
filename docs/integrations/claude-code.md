# Claude Code Integration

Connect Drift to a real Claude Code session in 3 steps.

---

## How It Works

Claude Code has a hooks system. You configure scripts that run on every tool call. Drift's Claude Code adapter reads these hook events and feeds them into the scoring pipeline.

```
Claude Code / CodeFuse CLI (running in your terminal)
    ↓  UserPromptSubmit → auto-sets goal from user's prompt
    ↓  PostToolUse → scores each tool call against current goal
scripts/claude-hook.ts (receives JSON from stdin)
    ↓
SessionManager → DriftScorer → NarrativeEngine
    ↓
Drift score + status printed to stderr
.drift-events.jsonl appended (for fixture generation)
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

## Step 2: Set Your Goal (Automatic or Manual)

### Automatic (Recommended)

If you also hook `UserPromptSubmit`, Drift will **automatically extract your prompt as the goal**. No manual configuration needed — every time you send a new prompt, it becomes the current goal.

Add this to the `UserPromptSubmit` hooks in your settings:

```json
"UserPromptSubmit": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx ts-node /path/to/drift/scripts/claude-hook.ts --event UserPromptSubmit"
      }
    ]
  }
]
```

### Manual (Optional Override)

If you want a fixed goal for the entire session, create a `.drift-session.json` file in your project root:

```json
{
  "goal": "fix the login bug in auth.ts",
  "allowed_domains": ["auth", "login", "session", "oauth"]
}
```

Manual config takes priority until the next `UserPromptSubmit` overrides it.

---

## Step 3: Run Claude Code Normally

```bash
claude
```

Drift runs in the background. After each tool call, you'll see drift status in a separate terminal pane (or in the hook output if Claude Code shows hook stderr).

---

## Hook Script

The hook script lives at `scripts/claude-hook.ts`. It handles both event types:

- **UserPromptSubmit**: captures user prompt as active goal
- **PostToolUse**: scores each tool call against the current goal

See the source file for full implementation. Key behaviors:

- Always exits 0 — never blocks the agent
- Writes status to stderr (visible in hook output)
- Appends every event to `.drift-events.jsonl` for fixture generation
- Persists state to `.drift-state.json`

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