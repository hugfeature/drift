/**
 * Generate a shareable HTML timeline from a Drift session.
 *
 * Run: npx ts-node scripts/generate-timeline.ts
 * Output: drift-timeline.html (open in any browser)
 */

import * as fs from 'fs'
import * as path from 'path'
import { SessionManager } from '../src/session/manager'

async function buildSession() {
  const sessionStart = Date.now() - 30 * 60_000
  const t = (m: number) => sessionStart + m * 60_000

  const session = new SessionManager({ agent: 'claude-code', started_at: sessionStart })
  const goalId = session.setGoal('fix README typo')
  await session.confirmGoal(goalId, {
    observable_targets: ['README.md'],
    allowed_domains: ['docs', 'readme'],
  })

  const events = [
    { label: 'Read README.md',             ts: t(1),  tool: 'read_file', target: 'README.md' },
    { label: 'Fix typo in README',         ts: t(2),  tool: 'edit_file', target: 'README.md', msg: 'Fix typo in introduction' },
    { label: 'Read .eslintrc',             ts: t(5),  tool: 'read_file', target: '.eslintrc.json', msg: 'Noticed lint warnings' },
    { label: 'Upgrade eslint to v9',       ts: t(8),  tool: 'bash',      msg: 'npm install eslint@9 --save-dev' },
    { label: 'Update eslint config',       ts: t(11), tool: 'edit_file', target: '.eslintrc.json', msg: 'Update for v9' },
    { label: 'Build fails — lint errors',  ts: t(14), tool: 'bash',      msg: 'npm run build' },
    { label: 'Fix lint errors in auth.ts', ts: t(18), tool: 'edit_file', target: 'src/auth.ts', msg: 'Fix lint errors' },
    { label: 'Tests fail',                 ts: t(22), tool: 'bash',      msg: 'npm test' },
    { label: 'Fix broken tests',           ts: t(26), tool: 'edit_file', target: 'src/auth.test.ts', msg: 'Update tests' },
  ]

  const results = []
  for (const e of events) {
    const result = await session.processEvent({
      type: 'tool_call', source: 'agent', timestamp: e.ts,
      payload: { tool_name: e.tool, target: e.target, message: e.msg },
    })
    results.push({ label: e.label, ts: e.ts, result, minuteOffset: Math.round((e.ts - sessionStart) / 60_000) })
  }

  const narrative = session.getNarrative()
  return { results, narrative, sessionStart }
}

function scoreColor(score: number): string {
  if (score < 0.5)  return '#22c55e'  // green
  if (score < 0.75) return '#f59e0b'  // amber
  return '#ef4444'                     // red
}

function statusBg(status: string): string {
  if (status === 'aligned')  return '#dcfce7'
  if (status === 'drifting') return '#fef3c7'
  return '#fee2e2'
}

function statusText(status: string): string {
  if (status === 'aligned')  return '#166534'
  if (status === 'drifting') return '#92400e'
  return '#991b1b'
}

function categoryColor(cat: string): string {
  if (cat === 'alignment')  return '#22c55e'
  if (cat === 'drift')      return '#f59e0b'
  if (cat === 'takeover')   return '#ef4444'
  if (cat === 'mutation')   return '#6366f1'
  return '#94a3b8'
}

async function main() {
  console.log('Building session...')
  const { results, narrative, sessionStart } = await buildSession()

  const maxScore = Math.max(...results.map(r => r.result.drift_score.score))
  const totalMinutes = results[results.length - 1].minuteOffset

  // Build score path for SVG chart
  const chartW = 600
  const chartH = 120
  const points = results.map((r, i) => {
    const x = (r.minuteOffset / totalMinutes) * chartW
    const y = chartH - (r.result.drift_score.score / 1.0) * chartH
    return `${x},${y}`
  })
  const pathD = `M ${points.join(' L ')}`

  // Fill area under curve
  const fillD = `M 0,${chartH} L ${pathD.slice(2)} L ${chartW},${chartH} Z`

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Drift — Session Timeline</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 40px 24px; }
  .container { max-width: 760px; margin: 0 auto; }

  .header { margin-bottom: 36px; }
  .header h1 { font-size: 28px; font-weight: 700; color: #f8fafc; letter-spacing: -0.5px; }
  .header h1 span { color: #ef4444; }
  .header p { margin-top: 8px; color: #64748b; font-size: 14px; }

  .goal-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px 20px; margin-bottom: 28px; display: flex; gap: 16px; align-items: center; }
  .goal-card .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; }
  .goal-card .value { font-size: 15px; color: #f1f5f9; font-weight: 500; margin-top: 2px; }
  .goal-card .badge { background: #dcfce7; color: #166534; font-size: 11px; padding: 3px 8px; border-radius: 20px; font-weight: 600; white-space: nowrap; }

  .section-title { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; font-weight: 600; }

  /* Score chart */
  .chart-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; margin-bottom: 28px; }
  .chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .chart-header .peak { font-size: 13px; color: #94a3b8; }
  .chart-header .peak span { color: #ef4444; font-weight: 700; }
  .chart-wrap { position: relative; }
  .threshold-line { stroke: #475569; stroke-dasharray: 4 4; stroke-width: 1; }
  .score-fill { fill: rgba(239,68,68,0.1); }
  .score-line { fill: none; stroke: #ef4444; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
  .chart-labels { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #475569; }
  .y-labels { position: absolute; left: -28px; top: 0; height: 120px; display: flex; flex-direction: column; justify-content: space-between; font-size: 10px; color: #475569; }

  /* Event table */
  .events-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; overflow: hidden; margin-bottom: 28px; }
  .event-row { display: grid; grid-template-columns: 52px 1fr 80px 90px; gap: 0; border-bottom: 1px solid #1e293b; padding: 11px 16px; align-items: center; transition: background 0.1s; }
  .event-row:last-child { border-bottom: none; }
  .event-row:hover { background: #263448; }
  .event-row.drift   { background: rgba(245,158,11,0.06); }
  .event-row.lost    { background: rgba(239,68,68,0.06); }
  .event-time { font-size: 12px; color: #64748b; font-variant-numeric: tabular-nums; }
  .event-label { font-size: 13px; color: #e2e8f0; }
  .event-label .tool { font-size: 11px; color: #475569; margin-top: 1px; }
  .event-score { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
  .status-pill { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 20px; text-align: center; white-space: nowrap; }
  .events-header { display: grid; grid-template-columns: 52px 1fr 80px 90px; gap: 0; padding: 10px 16px; border-bottom: 1px solid #334155; }
  .events-header span { font-size: 10px; color: #475569; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  .events-header span:nth-child(3), .events-header span:nth-child(4) { text-align: right; }

  /* Takeover banner */
  .takeover-banner { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); border-radius: 10px; padding: 14px 18px; margin-bottom: 28px; }
  .takeover-banner .title { color: #fca5a5; font-weight: 700; font-size: 14px; margin-bottom: 8px; }
  .takeover-banner .reason { color: #fca5a5; font-size: 13px; margin-top: 4px; opacity: 0.85; }
  .takeover-banner .action { color: #fcd34d; font-size: 13px; margin-top: 4px; }

  /* Narrative */
  .narrative-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 4px 0; margin-bottom: 28px; }
  .narrative-row { display: flex; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #1e293b; align-items: flex-start; }
  .narrative-row:last-child { border-bottom: none; }
  .narrative-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
  .narrative-text { font-size: 13px; color: #cbd5e1; line-height: 1.5; }
  .narrative-score { font-size: 11px; color: #475569; margin-top: 2px; }

  /* Signals */
  .signals-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 28px; }
  .signal-card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; }
  .signal-name { font-size: 11px; color: #64748b; margin-bottom: 6px; }
  .signal-value { font-size: 20px; font-weight: 700; color: #f1f5f9; }
  .signal-bar { height: 4px; background: #1e293b; border-radius: 2px; margin-top: 8px; overflow: hidden; border: 1px solid #334155; }
  .signal-bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }

  .footer { text-align: center; font-size: 12px; color: #334155; padding-top: 16px; }
  .footer a { color: #475569; text-decoration: none; }
  .footer a:hover { color: #94a3b8; }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>Drift <span>↗</span> Session Timeline</h1>
    <p>Agent Goal Alignment Analysis · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
  </div>

  <div class="goal-card">
    <div style="flex:1">
      <div class="label">Original Goal</div>
      <div class="value">"fix README typo"</div>
    </div>
    <div style="text-align:right">
      <div class="label">Agent</div>
      <div class="value">claude-code</div>
    </div>
    <div class="badge">DRIFTED</div>
  </div>

  <!-- Score Chart -->
  <div class="section-title">Drift Score Over Time</div>
  <div class="chart-card">
    <div class="chart-header">
      <span style="font-size:13px;color:#94a3b8">Score rises as agent deviates from original goal</span>
      <span class="peak">Peak: <span>${maxScore.toFixed(2)}</span></span>
    </div>
    <div class="chart-wrap" style="padding-left:32px">
      <div class="y-labels">
        <span>1.0</span><span>0.75</span><span>0.5</span><span>0.25</span><span>0</span>
      </div>
      <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}" preserveAspectRatio="none">
        <!-- threshold lines -->
        <line x1="0" y1="${chartH * 0.25}" x2="${chartW}" y2="${chartH * 0.25}" class="threshold-line"/>
        <line x1="0" y1="${chartH * 0.5}" x2="${chartW}" y2="${chartH * 0.5}" class="threshold-line"/>
        <!-- fill -->
        <path d="${fillD}" class="score-fill"/>
        <!-- line -->
        <path d="${pathD}" class="score-line"/>
        <!-- dots -->
        ${results.map(r => {
          const x = (r.minuteOffset / totalMinutes) * chartW
          const y = chartH - r.result.drift_score.score * chartH
          return `<circle cx="${x}" cy="${y}" r="4" fill="${scoreColor(r.result.drift_score.score)}" stroke="#0f172a" stroke-width="2"/>`
        }).join('\n        ')}
      </svg>
    </div>
    <div class="chart-labels">
      ${results.map(r => `<span>T+${r.minuteOffset}m</span>`).join('')}
    </div>
  </div>

  <!-- Takeover Banner -->
  ${results.some(r => r.result.takeover.recommended) ? `
  <div class="takeover-banner">
    <div class="title">⚠️ Human Takeover Recommended</div>
    ${results.find(r => r.result.takeover.recommended)!.result.takeover.reasons
      .map((r: string) => `<div class="reason">· ${r}</div>`).join('')}
    ${results.find(r => r.result.takeover.recommended)!.result.takeover.suggested_actions
      .map((a: string) => `<div class="action">→ ${a}</div>`).join('')}
  </div>` : ''}

  <!-- Event Table -->
  <div class="section-title">Event Stream</div>
  <div class="events-card">
    <div class="events-header">
      <span>Time</span><span>Action</span><span style="text-align:right">Score</span><span style="text-align:right">Status</span>
    </div>
    ${results.map(r => {
      const s = r.result.drift_score
      const tool = String(r.result.drift_score.signals ? (r as any).tool ?? '' : '')
      return `
    <div class="event-row ${s.status}">
      <div class="event-time">T+${r.minuteOffset}m</div>
      <div class="event-label">${r.label}</div>
      <div class="event-score" style="color:${scoreColor(s.score)}">${s.score.toFixed(2)}</div>
      <div style="text-align:right"><span class="status-pill" style="background:${statusBg(s.status)};color:${statusText(s.status)}">${s.status}</span></div>
    </div>`
    }).join('')}
  </div>

  <!-- Narrative -->
  <div class="section-title">Session Narrative</div>
  <div class="narrative-card">
    ${narrative.segments.map(seg => `
    <div class="narrative-row">
      <div class="narrative-dot" style="background:${categoryColor(seg.category)}"></div>
      <div>
        <div class="narrative-text">${seg.summary}</div>
        ${seg.drift_score_at_time !== undefined ? `<div class="narrative-score">score: ${seg.drift_score_at_time.toFixed(2)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>

  <!-- Signals -->
  <div class="section-title">Final Drift Signals</div>
  <div class="signals-grid">
    ${(() => {
      const last = results[results.length - 1].result.drift_score.signals
      const signals = [
        { name: 'Semantic Divergence',    value: `${Math.round(last.semantic_divergence * 100)}%`,           pct: last.semantic_divergence },
        { name: 'Exploratory Entropy',    value: `${Math.round(last.exploratory_entropy * 100)}%`,           pct: last.exploratory_entropy },
        { name: 'Consecutive Unrelated',  value: String(last.consecutive_unrelated),                        pct: last.consecutive_unrelated / 5 },
        { name: 'Unauthorized Mutations', value: String(last.unauthorized_mutations),                        pct: Math.min(last.unauthorized_mutations / 3, 1) },
        { name: 'Goal Inactive',          value: `${last.inactive_duration_minutes.toFixed(1)} min`,         pct: Math.min(last.inactive_duration_minutes / 10, 1) },
        { name: 'Subgoal Depth Risk',     value: `${Math.round(last.subgoal_depth * 100)}%`,                pct: last.subgoal_depth },
      ]
      return signals.map(s => `
    <div class="signal-card">
      <div class="signal-name">${s.name}</div>
      <div class="signal-value">${s.value}</div>
      <div class="signal-bar"><div class="signal-bar-fill" style="width:${Math.round(s.pct * 100)}%;background:${scoreColor(s.pct)}"></div></div>
    </div>`).join('')
    })()}
  </div>

  <div class="footer">
    Generated by <a href="https://github.com/hugfeature/drift">Drift</a> — Git Blame for Autonomous Agents
  </div>

</div>
</body>
</html>`

  const outPath = path.join(process.cwd(), 'drift-timeline.html')
  fs.writeFileSync(outPath, html)
  console.log(`\nTimeline saved: ${outPath}`)
  console.log('Open in browser to view.\n')
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})