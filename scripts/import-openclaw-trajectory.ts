/**
 * Import OpenClaw trajectory (.trajectory.jsonl) into Drift fixture format.
 *
 * OpenClaw stores session trajectories in:
 *   ~/.openclaw/agents/<agent-id>/sessions/<session-id>.trajectory.jsonl
 *
 * Trajectory format (each line is one of):
 *   - session.started   → {data: {trigger, workspaceDir, agentId, toolCount}}
 *   - trace.metadata    → {data: {model, config, plugins, skills}}
 *   - context.compiled  → compile context
 *   - prompt.submitted  → {data: {prompt, systemPrompt, messages, imagesCount}}
 *   - model.completed   → {data: {usage, aborted, ...}}
 *   - trace.artifacts   → {data: {toolMetas[], assistantTexts[], finalPromptText, itemLifecycle}}
 *   - session.ended     → end marker
 *
 * A single trajectory file may contain MULTIPLE turns (session.started → session.ended).
 *
 * Usage:
 *   npx ts-node scripts/import-openclaw-trajectory.ts <trajectory.jsonl> [output.json]
 *   npx ts-node scripts/import-openclaw-trajectory.ts --scan <directory>
 *
 * Options:
 *   --scan <dir>     Scan directory for large trajectory files
 *   --min-tools N    Skip sessions with fewer than N tool calls (default: 5)
 *   --goal <index>   Use Nth prompt as the goal (default: 1)
 */

import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrajectoryLine {
  type: string
  ts: string
  data?: Record<string, unknown>
}

interface Turn {
  startedAt: string
  trigger: string
  agentId: string
  prompt: string
  toolMetas: Array<{ toolName: string; meta: string }>
  assistantTexts: string[]
  usage: { input?: number; output?: number; total?: number }
  completedItems: number
}

interface ScanResult {
  file: string
  turns: number
  total_tool_calls: number
  prompts: string[]
  duration_minutes: number
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseTrajectory(filePath: string): Turn[] {
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')
  const turns: Turn[] = []
  let currentTurn: Partial<Turn> = {}

  for (const line of lines) {
    let parsed: TrajectoryLine
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const data = parsed.data || {}

    switch (parsed.type) {
      case 'session.started':
        currentTurn = {
          startedAt: parsed.ts,
          trigger: (data.trigger as string) || 'unknown',
          agentId: (data.agentId as string) || 'openclaw',
          prompt: '',
          toolMetas: [],
          assistantTexts: [],
          usage: {},
          completedItems: 0,
        }
        break

      case 'prompt.submitted':
        if (currentTurn) {
          currentTurn.prompt = (data.prompt as string) || ''
        }
        break

      case 'trace.artifacts': {
        if (currentTurn) {
          const toolMetas = (data.toolMetas as Array<{ toolName: string; meta: string }>) || []
          const assistantTexts = (data.assistantTexts as string[]) || []
          const itemLifecycle = (data.itemLifecycle as Record<string, number>) || {}
          const usage = (data.usage as Record<string, number>) || {}

          currentTurn.toolMetas = [...(currentTurn.toolMetas || []), ...toolMetas]
          currentTurn.assistantTexts = [...(currentTurn.assistantTexts || []), ...assistantTexts]
          currentTurn.usage = usage
          currentTurn.completedItems = (currentTurn.completedItems || 0) + (itemLifecycle.completedCount || 0)
        }
        break
      }

      case 'session.ended':
        if (currentTurn.startedAt) {
          turns.push(currentTurn as Turn)
        }
        currentTurn = {}
        break
    }
  }

  return turns
}

// ---------------------------------------------------------------------------
// Conversion to Drift fixture
// ---------------------------------------------------------------------------

function convertToFixture(
  turns: Turn[],
  goalIndex: number,
  sessionId: string
): Record<string, unknown> {
  const goalTurn = turns[goalIndex - 1] || turns[0]
  const goalPrompt = goalTurn?.prompt || 'unknown goal'
  const startedAt = turns.length > 0 ? new Date(turns[0].startedAt).getTime() : Date.now()
  const goalId = `goal_${sessionId.slice(0, 8)}`
  const agentId = goalTurn?.agentId || 'openclaw'

  // Build combined event stream: user prompts (goal_created) + tool calls
  let eventIndex = 0
  const allEvents: Array<Record<string, unknown>> = []

  for (let turnIdx = 0; turnIdx < turns.length; turnIdx++) {
    const turn = turns[turnIdx]
    const turnStart = new Date(turn.startedAt).getTime()

    // Emit user prompt event at start of each turn (if prompt exists)
    if (turn.prompt && turn.prompt.length > 0) {
      allEvents.push({
        id: `evt_user_${String(turnIdx + 1).padStart(3, '0')}`,
        timestamp: turnStart - 1,
        session_id: `sess_${sessionId}`,
        type: 'goal_created',
        source: 'human',
        goal_id: goalId,
        payload: {
          message: turn.prompt.slice(0, 200),
        },
      })
    }

    // Emit tool call events
    for (let toolIdx = 0; toolIdx < turn.toolMetas.length; toolIdx++) {
      const tool = turn.toolMetas[toolIdx]
      eventIndex++
      allEvents.push({
        id: `evt_${String(eventIndex).padStart(3, '0')}`,
        timestamp: turnStart + toolIdx * 1000,
        session_id: `sess_${sessionId}`,
        type: 'tool_call',
        source: 'agent',
        goal_id: goalId,
        goal_relation: 'aligned',
        relation_confidence: 0.5,
        payload: {
          tool_name: tool.toolName || 'unknown',
          message: (tool.meta || '').slice(0, 200),
        },
        drift_score_at_event: 0,
      })
    }
  }

  const allPrompts = turns.map(t => t.prompt).filter(Boolean)
  const totalToolCalls = turns.reduce((sum, t) => sum + t.toolMetas.length, 0)

  return {
    id: `fixture_imported_${sessionId.slice(0, 8)}`,
    description: `Imported OpenClaw trajectory: "${goalPrompt.slice(0, 60)}"`,
    agent: agentId,
    created_at: startedAt,
    source: 'imported_openclaw_trajectory',
    session: {
      id: `sess_${sessionId}`,
      started_at: startedAt,
      agent: agentId,
      active_goal_id: goalId,
      goals: [{
        id: goalId,
        created_at: startedAt,
        source: 'human',
        raw: goalPrompt,
        normalized: {
          observable_targets: [goalPrompt.slice(0, 100)],
          allowed_domains: extractDomains(goalPrompt),
        },
        confirmed: true,
        status: 'active',
        subgoal_depth: 0,
      }],
      events: allEvents,
    },
    label: {
      session_id: `sess_${sessionId}`,
      drift: false,
      takeover_required: false,
      annotator_notes: `Imported from OpenClaw trajectory. ${totalToolCalls} tool calls across ${allPrompts.length} turns (${allPrompts.length} user interactions injected). Goal (turn #${goalIndex}): "${goalPrompt.slice(0, 80)}". [ANNOTATE: review and label]`,
      annotated_by: 'human' as const,
    },
  }
}

function extractDomains(goalText: string): string[] {
  const cleaned = goalText
    .replace(/[\[\]（）【】《》「」]/g, ' ')
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
  const words = cleaned.split(/\s+/).filter(w => w.length > 2)
  return [...new Set(words)].slice(0, 10)
}

// ---------------------------------------------------------------------------
// Scan mode
// ---------------------------------------------------------------------------

function scanDirectory(dirPath: string, minTools: number): ScanResult[] {
  const results: ScanResult[] = []
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.trajectory.jsonl'))

  for (const file of files) {
    const fullPath = path.join(dirPath, file)
    try {
      const turns = parseTrajectory(fullPath)
      const totalToolCalls = turns.reduce((sum, t) => sum + t.toolMetas.length, 0)
      if (totalToolCalls < minTools) continue

      const prompts = turns.map(t => t.prompt).filter(Boolean)
      const startTime = turns.length > 0 ? new Date(turns[0].startedAt).getTime() : 0
      const endTime = turns.length > 0 ? new Date(turns[turns.length - 1].startedAt).getTime() : 0
      const duration = Math.round((endTime - startTime) / 60000)

      results.push({
        file,
        turns: turns.length,
        total_tool_calls: totalToolCalls,
        prompts: prompts.slice(0, 5).map(p => p.slice(0, 60)),
        duration_minutes: duration,
      })
    } catch {
      continue
    }
  }

  return results.sort((a, b) => b.total_tool_calls - a.total_tool_calls)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage:
  npx ts-node scripts/import-openclaw-trajectory.ts <trajectory.jsonl> [output.json]
  npx ts-node scripts/import-openclaw-trajectory.ts --scan <directory>

Options:
  --scan <dir>     List trajectory files sorted by tool call count
  --min-tools <N>  Skip sessions with fewer than N tool calls (default: 5)
  --goal <N>       Use the Nth turn's prompt as the goal (default: 1)

OpenClaw trajectory locations:
  ~/.openclaw/agents/main/sessions/<id>.trajectory.jsonl
  ~/.openclaw/agents/claude-code/sessions/<id>.trajectory.jsonl
  ~/.homiclaw/agents/main/sessions/<id>.trajectory.jsonl

Example:
  npx ts-node scripts/import-openclaw-trajectory.ts --scan ~/.openclaw/agents/main/sessions/
  npx ts-node scripts/import-openclaw-trajectory.ts ~/.openclaw/agents/main/sessions/abc.trajectory.jsonl
`)
    process.exit(0)
  }

  const minToolsIdx = args.indexOf('--min-tools')
  const minTools = minToolsIdx >= 0 ? parseInt(args[minToolsIdx + 1] || '5', 10) : 5
  const goalIdx = args.indexOf('--goal')
  const goalIndex = goalIdx >= 0 ? parseInt(args[goalIdx + 1] || '1', 10) : 1

  // Scan mode
  if (args.includes('--scan')) {
    const dirIdx = args.indexOf('--scan')
    const dirPath = path.resolve(args[dirIdx + 1] || '.')

    if (!fs.existsSync(dirPath)) {
      console.error(`Error: Directory not found: ${dirPath}`)
      process.exit(1)
    }

    const results = scanDirectory(dirPath, minTools)
    console.log(`\nFound ${results.length} trajectories with ${minTools}+ tool calls in ${dirPath}\n`)

    for (const r of results.slice(0, 20)) {
      console.log(`  ${r.file}`)
      console.log(`    Turns: ${r.turns} | Tool calls: ${r.total_tool_calls} | Duration: ~${r.duration_minutes}min`)
      console.log(`    Prompts: ${r.prompts.map(p => `"${p}"`).join(', ')}`)
      console.log()
    }
    process.exit(0)
  }

  // Import mode
  const inputFile = path.resolve(args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || '')
  const nonFlagArgs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  const outputFile = nonFlagArgs.length > 1
    ? path.resolve(nonFlagArgs[1])
    : inputFile.replace(/\.trajectory\.jsonl$/, '_drift_fixture.json')

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: File not found: ${inputFile}`)
    process.exit(1)
  }

  const sessionId = path.basename(inputFile, '.trajectory.jsonl')
  const turns = parseTrajectory(inputFile)

  if (turns.length === 0) {
    console.error('Error: No valid turns found in trajectory.')
    process.exit(1)
  }

  const totalToolCalls = turns.reduce((sum, t) => sum + t.toolMetas.length, 0)
  const fixture = convertToFixture(turns, goalIndex, sessionId)
  fs.writeFileSync(outputFile, JSON.stringify(fixture, null, 2))

  const prompts = turns.map(t => t.prompt).filter(Boolean)
  console.log(`
✓ Imported OpenClaw trajectory: ${outputFile}

  Session: ${sessionId}
  Agent: ${turns[0]?.agentId || 'openclaw'}
  Turns: ${turns.length}
  Goal (turn #${goalIndex}): "${prompts[goalIndex - 1]?.slice(0, 60) || 'unknown'}"
  Tool calls: ${totalToolCalls}
  Prompts: ${prompts.length}

Next steps:
  1. Run scorer: npx ts-node scripts/score-fixture.ts ${outputFile}
  2. Anonymize: npx ts-node scripts/anonymize-session.ts ${outputFile}
  3. Review and label drift/no-drift
`)
}

main()
