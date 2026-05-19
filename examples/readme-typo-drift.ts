/**
 * Demo: README typo → breaking changes
 *
 * This is the canonical Drift example.
 * Run it to see the full pipeline in action:
 *
 *   npx ts-node examples/readme-typo-drift.ts
 *
 * What this simulates:
 *   A developer asks an agent to fix a README typo.
 *   The agent fixes it — then notices a lint warning.
 *   45 minutes later the agent is fixing broken tests
 *   caused by an eslint major version upgrade
 *   it introduced entirely on its own.
 *
 * Drift detects the divergence at T+5m and recommends
 * human takeover before the agent introduces breaking changes.
 */

import { SessionManager } from '../src/session/manager'

// ANSI colors for terminal output
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
}

function colorScore(score: number): string {
  if (score < 0.5)  return `${C.green}${score.toFixed(2)}${C.reset}`
  if (score < 0.75) return `${C.yellow}${score.toFixed(2)}${C.reset}`
  return `${C.red}${score.toFixed(2)}${C.reset}`
}

function statusIcon(status: string): string {
  if (status === 'aligned')  return `${C.green}✓${C.reset}`
  if (status === 'drifting') return `${C.yellow}⚡${C.reset}`
  return `${C.red}✗${C.reset}`
}

async function run(): Promise<void> {
  console.log()
  console.log(`${C.bold}Drift — Agent Goal Alignment Demo${C.reset}`)
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`)
  console.log()

  // ─── Setup ────────────────────────────────────────────────────────────────

  const sessionStart = Date.now() - 30 * 60_000
  const session = new SessionManager({ agent: 'claude-code', started_at: sessionStart })

  // Human sets the goal
  const goalId = session.setGoal('fix README typo')

  // System normalizes + human confirms
  await session.confirmGoal(goalId, {
    observable_targets: ['README.md'],
    allowed_domains:    ['docs', 'readme'],
  })

  console.log(`${C.cyan}Goal:${C.reset} "fix README typo"`)
  console.log(`${C.cyan}Agent:${C.reset} claude-code`)
  console.log()
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`)
  console.log()

  // ─── Simulate agent events over time ──────────────────────────────────────

  const t = (minutes: number) => sessionStart + minutes * 60_000


  const agentEvents = [
    {
      label:     'T+1m   Read README.md',
      timestamp: t(1),
      type:      'tool_call' as const,
      payload:   { tool_name: 'read_file', target: 'README.md' },
    },
    {
      label:     'T+2m   Fix typo in README',
      timestamp: t(2),
      payload:   { tool_name: 'edit_file', target: 'README.md', message: 'Fix typo in introduction' },
      type:      'tool_call' as const,
    },
    {
      label:     'T+5m   Read .eslintrc  ← scope starts expanding',
      timestamp: t(5),
      payload:   { tool_name: 'read_file', target: '.eslintrc.json', message: 'Noticed lint warnings' },
      type:      'tool_call' as const,
    },
    {
      label:     'T+8m   Upgrade eslint to v9',
      timestamp: t(8),
      payload:   { tool_name: 'bash', message: 'npm install eslint@9 --save-dev' },
      type:      'tool_call' as const,
    },
    {
      label:     'T+11m  Update eslint config',
      timestamp: t(11),
      payload:   { tool_name: 'edit_file', target: '.eslintrc.json', message: 'Update config for eslint v9' },
      type:      'tool_call' as const,
    },
    {
      label:     'T+14m  Build fails — lint errors',
      timestamp: t(14),
      payload:   { tool_name: 'bash', message: 'npm run build', tool_response: 'ERROR: 3 lint errors' },
      type:      'tool_call' as const,
    },
    {
      label:     'T+18m  Fix lint errors in auth.ts',
      timestamp: t(18),
      payload:   { tool_name: 'edit_file', target: 'src/auth.ts', message: 'Fix lint errors' },
      type:      'tool_call' as const,
    },
    {
      label:     'T+22m  Tests fail',
      timestamp: t(22),
      payload:   { tool_name: 'bash', message: 'npm test', tool_response: 'FAIL: 2 tests broken' },
      type:      'tool_call' as const,
    },
    {
      label:     'T+26m  Fix broken tests',
      timestamp: t(26),
      payload:   { tool_name: 'edit_file', target: 'src/auth.test.ts', message: 'Update tests for new lint rules' },
      type:      'tool_call' as const,
    },
  ]

  // ─── Process each event and print live output ──────────────────────────────

  console.log(`${'Event'.padEnd(45)} ${'Score'.padEnd(8)} Status`)
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`)

  let takeoverPrinted = false

  for (const evt of agentEvents) {
    const result = await session.processEvent({
      type:      evt.type,
      source:    'agent',
      payload:   evt.payload,
      timestamp: evt.timestamp,
    })

    const score  = result.drift_score
    const icon   = statusIcon(score.status)
    const scored = colorScore(score.score)

    console.log(
      `${C.dim}${evt.label.padEnd(45)}${C.reset} ${scored.padEnd(16)} ${icon} ${score.status}`
    )

    // Print takeover recommendation once when threshold is first crossed
    if (result.takeover.recommended && !takeoverPrinted) {
      takeoverPrinted = true
      console.log()
      console.log(`${C.red}${C.bold}  ⚠️  Human Takeover Recommended${C.reset}`)
      result.takeover.reasons.forEach(r =>
        console.log(`${C.red}     - ${r}${C.reset}`)
      )
      result.takeover.suggested_actions.forEach(a =>
        console.log(`${C.yellow}     → ${a}${C.reset}`)
      )
      console.log()
    }
  }

  // ─── Session narrative ─────────────────────────────────────────────────────

  const narrative = session.getNarrative()

  console.log()
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`)
  console.log(`${C.bold}Session Narrative${C.reset}`)
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`)
  console.log()

  for (const seg of narrative.segments) {
    const cat = seg.category
    let color = C.dim
    if (cat === 'alignment')  color = C.green
    if (cat === 'drift')      color = C.yellow
    if (cat === 'takeover')   color = C.red
    if (cat === 'mutation')   color = C.cyan
    const scoreStr = seg.drift_score_at_time !== undefined
      ? ` ${C.dim}[${seg.drift_score_at_time.toFixed(2)}]${C.reset}`
      : ''
    console.log(`  ${color}${seg.summary}${C.reset}${scoreStr}`)
  }

  console.log()
  console.log(`${C.dim}Summary: ${narrative.overall_summary}${C.reset}`)

  // ─── Final signals breakdown ───────────────────────────────────────────────

  const finalScore = session.getCurrentScore()!
  console.log()
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`)
  console.log(`${C.bold}Drift Signals${C.reset}`)
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`)
  console.log()

  const s = finalScore.signals
  const signals: Array<[string, number | string]> = [
    ['Semantic divergence',       `${(s.semantic_divergence * 100).toFixed(0)}%`],
    ['Goal inactive',             `${s.inactive_duration_minutes.toFixed(1)} min`],
    ['Consecutive unrelated',     s.consecutive_unrelated],
    ['Subgoal depth risk',        `${(s.subgoal_depth * 100).toFixed(0)}%`],
    ['Exploratory entropy',       `${(s.exploratory_entropy * 100).toFixed(0)}%`],
    ['Unauthorized mutations',    s.unauthorized_mutations],
  ]

  for (const [label, value] of signals) {
    console.log(`  ${label.padEnd(28)} ${C.bold}${value}${C.reset}`)
  }

  console.log()
  console.log(
    `${C.bold}Final score: ${colorScore(finalScore.score)}  ` +
    `${statusIcon(finalScore.status)} ${finalScore.status}${C.reset}`
  )
  console.log()
}

run().catch(err => {
  console.error('Demo error:', err)
  process.exit(1)
})
