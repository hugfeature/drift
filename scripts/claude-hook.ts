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
import { CandidateCollector, type CandidateEvent, type CandidateSession } from '../src/eval/candidate-collector'
import { CompositeScorer } from '../src/scoring/composite'
import { AuthorizationPolicy } from '../src/governance/policy'
import {
  resolveEnforcement,
  enforcementConfigFromEnv,
  toHookOutput,
} from '../src/governance/enforcement'
import { normalizeEvents } from '../src/risk/normalizer'
import { runAllDetectors } from '../src/risk/detectors'
import type { RawFixtureEvent } from '../src/risk/types'
import type { DriftScore, DriftStatus, DriftSignals } from '../src/types/scoring'
import type { ScorerPersistentState } from '../src/scoring/scorer'
import { sanitizeGoal } from '../src/goal/sanitize'

// ---------------------------------------------------------------------------
// Per-session state location
// ---------------------------------------------------------------------------
//
// State files (state.json + events.jsonl) are scoped by Claude Code's own
// session_id, NOT by CWD or project root. Rationale:
//
//   1. Codex / Claude / CodeFuse are typically launched from a small set of
//      fixed directories (~, ~/skill); CWD-scoping would put unrelated work
//      into the same bucket and let parallel clients overwrite each other.
//   2. A new task is bounded by `/clear` (or a fresh launch), which makes
//      Claude Code allocate a new session_id — exactly the boundary we want.
//   3. Resuming a session from a different subdirectory keeps the same
//      session_id, so state stays continuous without any path heuristics.
//
// Each hook event from Claude Code carries `session_id` on its stdin payload.
// We resolve the directory lazily once the payload is parsed, then memoize.

const HOME = process.env.HOME || process.env.USERPROFILE || ''
const CWD  = process.cwd()
const DRIFT_HOME = process.env.DRIFT_HOME || path.join(HOME, '.drift')

// SESSION_FILE (user-maintained goal config) keeps its old CWD-or-HOME lookup
// — it's an *input* to Drift, not Drift-owned state.
const GLOBAL_SESSION_FILE = path.join(HOME, '.drift-session.json')
const SESSION_FILE        = path.join(CWD, '.drift-session.json')

let SESSION_DIR:  string = ''
let STATE_FILE:   string = ''
let EVENTS_FILE:  string = ''

/**
 * Initialize the per-session state directory from the hook payload.
 * Must be called exactly once per hook invocation, after the payload is
 * parsed. Falls back to a stable "unscoped" bucket only when no session_id
 * is present (manual testing / non-Claude-Code callers).
 */
function initSessionPaths(payload: Record<string, unknown>): void {
  const sid = (typeof payload['session_id'] === 'string' && payload['session_id'])
    || process.env.DRIFT_SESSION_ID
    || 'unscoped'
  SESSION_DIR = path.join(DRIFT_HOME, 'sessions', sid)
  STATE_FILE  = path.join(SESSION_DIR, 'state.json')
  EVENTS_FILE = path.join(SESSION_DIR, 'events.jsonl')
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }) } catch { /* best-effort */ }
}

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
  current_goal:  string        // the actual goal text (from prompt or config), truncated to 300
  /**
   * The FULL, untruncated user prompt. current_goal is truncated to 300 chars
   * for the semantic-divergence baseline, but the cognitive detectors — notably
   * completion_coverage_gap — need the full prompt because quantity constraints
   * ("写三篇文章") often live in the prompt tail that truncation drops. Without
   * this the coverage detector goes blind on long prompts. Optional for
   * back-compat with state written before this field existed.
   */
  current_prompt?: string
  event_count:   number
  /**
   * Cross-process scorer state (lastAlignedAt + goal embedding cache).
   * Persisted so each PostToolUse process restores the prior aligned timestamps
   * and embedding cache instead of starting blank. Optional for back-compat
   * with state files written before this field existed.
   */
  scorer_state?: ScorerPersistentState
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
 * Fuse the v0.1 final score with v0.2 cognitive-layer detectors so candidate
 * collection is gated on the composite, not the raw v0.1 score. A session a
 * zero-FP cognitive signal flagged (composite lifted to the cognitive floor)
 * is then captured even when its v0.1 score stayed below the drift threshold.
 *
 * Detectors run statelessly over the persisted tool-call stream (O(N)). Only
 * the whitelisted cognitive signals (returned in breakdown.cognitive_signals)
 * lift the composite; execution-layer detectors are ignored here since they
 * already live in the v0.1 score.
 */
function computeCompositeForCollection(
  events: CandidateEvent[],
  goalText: string,
  promptText: string,
  finalScore: number,
  finalStatus: string,
): { compositeScore: number; cognitiveSignals: string[] } {
  try {
    const toolEvents = events.filter(e => e.event_type === 'tool_call')
    const normalized = normalizeEvents(
      toolEvents.map(e => ({
        tool_name:  e.tool_name,
        tool_input: e.tool_input,
        message:    e.message,
      })) as unknown as RawFixtureEvent[],
    )
    // goalText → trajectory_divergence; promptText (full) → completion_coverage_gap.
    const cognitiveSignals = runAllDetectors(normalized, goalText, promptText)

    const executionScore: DriftScore = {
      score:                  finalScore,
      status:                 (finalStatus as DriftStatus) ?? 'aligned',
      signals:                {} as DriftSignals,
      computed_at:            Date.now(),
      contributing_event_ids: [],
    }

    const composite = new CompositeScorer().fuse(executionScore, cognitiveSignals)
    const names = [...new Set(composite.breakdown.cognitive_signals.map(s => s.signal))]
    return { compositeScore: composite.score, cognitiveSignals: names }
  } catch {
    // On any failure fall back to the raw v0.1 score — collection must not break.
    return { compositeScore: finalScore, cognitiveSignals: [] }
  }
}

/**
 * Auto-collect session as eval candidate fixture if confidence is high enough.
 * Reads .drift-events.jsonl, computes final score, and writes to eval/candidates/.
 */
function collectCandidate(state: DriftState): void {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return

    const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').trim().split('\n')
    const events: CandidateEvent[] = lines
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter((e): e is CandidateEvent => e !== null)

    // Find the last scored event to get final drift score
    const scoredEvents = events.filter(e => typeof e.drift_score === 'number')
    if (scoredEvents.length === 0) return

    const lastScored = scoredEvents[scoredEvents.length - 1]
    const finalScore = lastScored.drift_score ?? 0

    // Fuse the v0.1 final score with v0.2 cognitive hits so a session a
    // cognitive signal flagged is captured even if its v0.1 score stayed low.
    const { compositeScore, cognitiveSignals } = computeCompositeForCollection(
      events,
      state.current_goal,
      state.current_prompt ?? state.current_goal,
      finalScore,
      lastScored.status ?? 'aligned',
    )

    const candidateSession: CandidateSession = {
      session_id:  state.session_id,
      started_at:  state.started_at,
      agent:       'claude-code',
      goal:        state.current_goal,
      events,
      final_score: finalScore,
      final_status: lastScored.status ?? 'unknown',
      event_count: state.event_count,
      composite_score:   compositeScore,
      cognitive_signals: cognitiveSignals,
    }

    const collector = new CandidateCollector()
    const outputPath = collector.collect(candidateSession)

    if (outputPath) {
      const label = compositeScore >= 0.7 ? 'drift' : 'aligned'
      const tag = cognitiveSignals.length > 0 ? ` [cognitive: ${cognitiveSignals.join(',')}]` : ''
      log(`📦 Auto-collected as ${label} candidate (composite=${compositeScore.toFixed(2)})${tag} → ${path.basename(outputPath)}`)
    }
  } catch (err) {
    // Non-critical — don't let collection failures break the hook
    log(`⚠️  Candidate collection skipped: ${(err as Error).message}`)
  }
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
      // Sanitize at the capture boundary: reject interruption markers, skill
      // injection, and image-only text so a polluted goal is never set.
      const clean = sanitizeGoal(c)
      if (clean) return clean
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Detect hook event type from CLI args or payload
// ---------------------------------------------------------------------------

function getHookEventType(payload: Record<string, unknown>): 'session_start' | 'user_prompt' | 'pre_tool_call' | 'tool_call' | 'stop' | 'unknown' {
  // Check CLI args first (--event flag)
  const eventArgIndex = process.argv.indexOf('--event')
  if (eventArgIndex !== -1) {
    const eventType = process.argv[eventArgIndex + 1]
    if (eventType === 'SessionStart') return 'session_start'
    if (eventType === 'Stop') return 'stop'
    if (eventType === 'UserPromptSubmit') return 'user_prompt'
    if (eventType === 'PreToolUse') return 'pre_tool_call'
    if (eventType === 'PostToolUse') return 'tool_call'
  }

  // Infer from payload content. PreToolUse carries tool_name but NO result;
  // PostToolUse carries a result field. Use that to disambiguate when the
  // --event flag is absent.
  if (payload['tool_name']) {
    const hasResult = payload['tool_result'] !== undefined || payload['tool_response'] !== undefined
    return hasResult ? 'tool_call' : 'pre_tool_call'
  }
  if (payload['prompt'] || payload['user_prompt'] || payload['message']) return 'user_prompt'

  return 'unknown'
}

// ---------------------------------------------------------------------------
// PreToolUse enforcement — compute composite risk before the tool runs
// ---------------------------------------------------------------------------

/**
 * Load the historical event stream this session has accumulated so far.
 * PreToolUse risk is computed from history + the tool about to run.
 */
function loadHistoricalToolEvents(): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return []
    return fs.readFileSync(EVENTS_FILE, 'utf-8')
      .trim()
      .split('\n')
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter((e): e is Record<string, unknown> => e !== null && e['event_type'] === 'tool_call')
  } catch {
    return []
  }
}

/**
 * Map persisted tool_call entries into seedHistory() inputs (RawEvent shape
 * minus session_id). Timestamps are preserved so duration / inactive_duration
 * signals stay faithful to when actions actually happened.
 */
function historyToSeedEvents(
  history: Record<string, unknown>[],
): Array<{ type: 'tool_call'; source: 'agent'; timestamp?: number; payload: Record<string, unknown> }> {
  return history.map(e => ({
    type:      'tool_call' as const,
    source:    'agent' as const,
    timestamp: typeof e['timestamp'] === 'number' ? (e['timestamp'] as number) : undefined,
    payload: {
      tool_name:     e['tool_name'],
      tool_input:    e['tool_input'],
      tool_response: e['tool_result'] ?? e['tool_response'],
      message:       e['message'],
    },
  }))
}

/**
 * Emit the PreToolUse decision on stdout — cross-CLI safe (Claude Code + codex).
 *
 * Only a hard `deny` writes anything: it is the single permissionDecision value
 * both CLIs honor. `allow` and `ask` proceed via SILENCE — we write NOTHING to
 * stdout. This is required because codex throws on any non-`deny` value
 * (`unsupported permissionDecision: allow`), and Claude Code treats a silent
 * hook as default-allow. The `ask` pause is not portable to codex, so its
 * intent is surfaced via the stderr log instead, never via stdout.
 */
function emitPermissionDecision(decision: 'ask' | 'deny' | 'allow', reason: string): void {
  if (decision !== 'deny') return // proceed silently — no stdout for allow/ask

  const output = toHookOutput({
    permissionDecision: 'deny',
    paused:             true,
    soft_advisory:      null,
    reason,
  })
  process.stdout.write(JSON.stringify(output) + '\n')
}

/**
 * Look up the most recent v0.1 DriftScore snapshot in the event stream.
 * PostToolUse persists `drift_score` and `status` onto each tool_call entry,
 * so PreToolUse can read the latest snapshot in O(N) instead of replaying
 * the whole stream through SessionManager (which would be O(N²) per hook).
 *
 * Returns null if no scored event exists yet (e.g. the very first tool call
 * of a session). Caller must handle by allowing the call.
 */
function lastDriftScoreSnapshot(): DriftScore | null {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return null
    const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: Record<string, unknown>
      try { entry = JSON.parse(lines[i]) } catch { continue }
      if (entry['event_type'] !== 'tool_call') continue
      if (typeof entry['drift_score'] !== 'number') continue
      return {
        score:                  entry['drift_score'] as number,
        status:                 (entry['status'] as DriftStatus) ?? 'aligned',
        signals:                {} as DriftSignals,
        computed_at:            (entry['timestamp'] as number) ?? Date.now(),
        contributing_event_ids: [],
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * PreToolUse handler. Reuses the FULL composite (v0.1 + v0.2). At this point
 * the tool has not run, so there is no tool_result — hallucinated_claims simply
 * has nothing to fire on (degrades to 0), no separate signal subset needed.
 *
 * **Design**: do NOT rebuild SessionManager or replay history here. PostToolUse
 * already maintains the v0.1 DriftScore on each tool_call event; PreToolUse
 * just reads the most recent snapshot. v0.2 detectors are stateless and only
 * cost O(N) over the existing event stream — that we still run, since they
 * are the cheap part. This keeps each PreToolUse hook bounded regardless of
 * session length.
 *
 * The score we use is "history up to the previous tool call" — the right
 * semantics for a PRE-execution decision (we're judging whether to allow the
 * next step, not what it would do). If the session has no scored history yet
 * (very first tool call), we allow.
 *
 * Enforcement is OFF unless DRIFT_ENFORCE=1. When off, this is pure advisory.
 */
async function handlePreToolUse(payload: Record<string, unknown>): Promise<void> {
  const enforcementConfig = enforcementConfigFromEnv()

  const toolName = payload['tool_name'] as string | undefined
  if (!toolName) {
    emitPermissionDecision('allow', 'No tool name in payload')
    return
  }

  const state = loadState()
  if (!state) {
    emitPermissionDecision('allow', 'No active goal — Drift cannot score')
    return
  }

  const executionScore = lastDriftScoreSnapshot()
  if (!executionScore) {
    emitPermissionDecision('allow', 'No scored history yet — first tool call')
    return
  }

  // v0.2 cognitive signals: stateless O(N) sweep over the existing stream.
  // We deliberately do NOT include the pending tool call — the detectors
  // judge what has already happened. Including a not-yet-executed call
  // would let speculative input distort the signal.
  const historical = loadHistoricalToolEvents()
  const normalized = normalizeEvents(
    historical.map(e => ({
      tool_name:  e['tool_name'],
      tool_input: e['tool_input'],
      message:    e['message'],
    })) as unknown as RawFixtureEvent[],
  )
  // goalText drives trajectory_divergence (domain inference); promptText drives
  // completion_coverage_gap (quantity constraints). Use the FULL prompt for the
  // latter — the truncated goal would drop tail constraints like "写三篇文章".
  const promptText = state.current_prompt ?? state.current_goal
  const cognitiveSignals = runAllDetectors(normalized, state.current_goal, promptText)

  // Fuse + decide + enforce.
  const composite = new CompositeScorer().fuse(executionScore, cognitiveSignals)
  const verdict = new AuthorizationPolicy().decide(composite)
  const enforcement = resolveEnforcement(verdict, enforcementConfig)

  const icon = enforcement.paused ? '⛔' : composite.status === 'aligned' ? '✓' : '⚡'
  log(`${icon} PreToolUse risk=${composite.score.toFixed(2)} (${verdict.decision}) tool=${toolName} enforce=${enforcementConfig.enabled}`)

  if (enforcement.soft_advisory) log(enforcement.soft_advisory)
  if (enforcement.paused) log(`⛔ Pausing for confirmation: ${enforcement.reason}`)

  emitPermissionDecision(enforcement.permissionDecision, enforcement.reason)
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

  // Resolve per-session state paths from the Claude Code session_id on the
  // payload. Must happen before any STATE_FILE / EVENTS_FILE access.
  initSessionPaths(payload)

  const eventType = getHookEventType(payload)

  // ---------------------------------------------------------------------------
  // Handle SessionStart — reset state, start fresh drift session
  // ---------------------------------------------------------------------------

  if (eventType === 'session_start') {
    // Clean previous session state — new Claude Code session = new drift session
    try { fs.unlinkSync(STATE_FILE) } catch { /* no previous state */ }
    try { fs.unlinkSync(EVENTS_FILE) } catch { /* no previous events */ }

    log('🔄 New session started (state + events reset)')

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

      // Auto-collect candidate fixture for eval set growth
      collectCandidate(savedState)
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
      session_id:    session.session_id,
      started_at:    session.started_at,
      goal_id:       goalId,
      current_goal:  goalText,
      current_prompt: promptText,   // full, untruncated — for cognitive detectors
      event_count:   savedState?.event_count ?? 0,
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
  // Handle PreToolUse — compute risk BEFORE the tool runs, optionally pause
  // ---------------------------------------------------------------------------

  if (eventType === 'pre_tool_call') {
    await handlePreToolUse(payload)
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
      session_id:    session.session_id,
      started_at:    session.started_at,
      goal_id:       goalId,
      current_goal:  goalConfig.goal,
      current_prompt: goalConfig.goal,   // config has no separate prompt
      event_count:   0,
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

  // Restore cross-process scorer state (lastAlignedAt + goal embedding cache)
  // so inactive_duration measures from the real last aligned action and the
  // goal vector is not re-embedded on every tool call.
  session.hydrateScorerState(state.scorer_state)

  // Seed prior tool-call history WITHOUT scoring it, so the current call is
  // scored against the full session window (consecutive_unrelated,
  // exploratory_entropy, autonomy_momentum all need history). Only the current
  // event is scored — O(N) per hook, not O(N²) replay.
  const history = loadHistoricalToolEvents()
  await session.seedHistory(historyToSeedEvents(history))

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
  // Persist updated scorer state for the next hook process.
  state.scorer_state = session.dumpScorerState()
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