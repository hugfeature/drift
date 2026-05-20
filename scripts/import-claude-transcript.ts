/**
 * Import Claude Code transcript (.jsonl) into Drift fixture format.
 *
 * Claude Code stores session transcripts in:
 *   ~/.codefuse/engine/cc/projects/<project-slug>/<session-id>.jsonl
 *
 * Transcript format:
 *   - type: "user"      → user prompt (message.content = [{type:"text", text:"..."}])
 *   - type: "assistant" → agent response (message.content = [{type:"tool_use", name, input}])
 *   - type: "attachment", "permission-mode", "file-history-snapshot", etc.
 *
 * This script extracts tool_use events, groups them by user prompt (goal),
 * and outputs a Drift-compatible fixture JSON.
 *
 * Usage:
 *   npx ts-node scripts/import-claude-transcript.ts <transcript.jsonl> [output.json]
 *   npx ts-node scripts/import-claude-transcript.ts --scan <directory>
 *
 * Options:
 *   --scan <dir>    Scan directory for .jsonl files, show summary of each
 *   --goal <index>  Use the Nth user prompt as the goal (default: 1)
 *   --min-events N  Skip sessions with fewer than N tool calls (default: 5)
 */

import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranscriptLine {
  type: string
  timestamp?: string
  message?: {
    content: Array<{
      type: string
      text?: string
      name?: string
      input?: Record<string, unknown>
      id?: string
    }>
  }
  uuid?: string
  parentUuid?: string
}

interface ExtractedEvent {
  id: string
  timestamp: number
  tool_name: string
  message: string
  target?: string
  prompt_index: number
  prompt_text: string
}

interface ScanResult {
  file: string
  lines: number
  tool_calls: number
  user_prompts: string[]
  duration_minutes: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskComplete',
  'EnterPlanMode', 'ExitPlanMode',
  'mcp__engram__recall_memory', 'mcp__engram__create_task',
  'mcp__engram__track_progress',
])

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseTranscript(filePath: string): { events: ExtractedEvent[]; prompts: string[] } {
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')
  const events: ExtractedEvent[] = []
  const prompts: string[] = []

  let currentPrompt = ''
  let promptIndex = 0
  let eventIndex = 0
  let baseTimestamp = Date.now()
  let lastTimestamp = baseTimestamp

  for (const line of lines) {
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (parsed.timestamp) {
      lastTimestamp = new Date(parsed.timestamp).getTime() || lastTimestamp
      if (eventIndex === 0) baseTimestamp = lastTimestamp
    }

    if (parsed.type === 'user' && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === 'text' && block.text) {
          const text = block.text.trim()
          if (text.length > 0 && !text.startsWith('This session is being continued')) {
            currentPrompt = text.slice(0, 200)
            promptIndex++
            prompts.push(currentPrompt)
          }
          break
        }
      }
    }

    if (parsed.type === 'assistant' && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === 'tool_use' && block.name) {
          eventIndex++
          const input = block.input || {}
          const message = (input.description as string)
            || (input.command as string)
            || (input.content as string)
            || ''
          const target = (input.file_path as string) || (input.filePath as string) || ''

          events.push({
            id: `evt_${String(eventIndex).padStart(3, '0')}`,
            timestamp: lastTimestamp + eventIndex,
            tool_name: block.name,
            message: message.slice(0, 200),
            target: target || undefined,
            prompt_index: promptIndex,
            prompt_text: currentPrompt,
          })
        }
      }
    }
  }

  return { events, prompts }
}

// ---------------------------------------------------------------------------
// Conversion to Drift fixture
// ---------------------------------------------------------------------------

function convertToFixture(
  events: ExtractedEvent[],
  prompts: string[],
  goalIndex: number,
  sessionId: string
): Record<string, unknown> {
  const goalPrompt = prompts[goalIndex - 1] || prompts[0] || 'unknown goal'
  const startedAt = events.length > 0 ? events[0].timestamp : Date.now()
  const goalId = `goal_${sessionId.slice(0, 8)}`

  // Build combined event stream: user prompts (goal_created) + tool calls
  // This gives the scorer visibility into user interaction patterns.
  const allEvents: Array<Record<string, unknown>> = []

  // Track which prompt_index values we've already emitted as user events
  const emittedPrompts = new Set<number>()

  for (const e of events) {
    // Emit user prompt event before first tool call of each prompt group
    if (e.prompt_index > 0 && !emittedPrompts.has(e.prompt_index)) {
      emittedPrompts.add(e.prompt_index)
      allEvents.push({
        id: `evt_user_${String(e.prompt_index).padStart(3, '0')}`,
        timestamp: e.timestamp - 1, // just before the tool call
        session_id: `sess_${sessionId}`,
        type: 'goal_created',
        source: 'human',
        goal_id: goalId,
        payload: {
          message: e.prompt_text.slice(0, 200),
        },
      })
    }

    // Emit tool call event
    allEvents.push({
      id: e.id,
      timestamp: e.timestamp,
      session_id: `sess_${sessionId}`,
      type: 'tool_call',
      source: 'agent',
      goal_id: goalId,
      goal_relation: 'aligned',
      relation_confidence: 0.5,
      payload: {
        tool_name: e.tool_name,
        message: e.message,
        ...(e.target ? { target: e.target } : {}),
      },
      drift_score_at_event: 0,
    })
  }

  const fixture = {
    id: `fixture_imported_${sessionId.slice(0, 8)}`,
    description: `Imported Claude Code session: "${goalPrompt.slice(0, 60)}"`,
    agent: 'claude-code',
    created_at: startedAt,
    source: 'imported_claude_transcript',
    session: {
      id: `sess_${sessionId}`,
      started_at: startedAt,
      agent: 'claude-code',
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
      annotator_notes: `Imported from Claude Code transcript. ${events.length} tool calls across ${prompts.length} user prompts (${emittedPrompts.size} user interactions injected). Goal (prompt #${goalIndex}): "${goalPrompt.slice(0, 80)}". [ANNOTATE: review and label]`,
      annotated_by: 'human' as const,
    },
  }

  return fixture
}

function extractDomains(goalText: string): string[] {
  const words = goalText.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
  return [...new Set(words)].slice(0, 10)
}

// ---------------------------------------------------------------------------
// Scan mode
// ---------------------------------------------------------------------------

function scanDirectory(dirPath: string, minEvents: number): ScanResult[] {
  const results: ScanResult[] = []
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))

  for (const file of files) {
    const fullPath = path.join(dirPath, file)
    try {
      const { events, prompts } = parseTranscript(fullPath)
      if (events.length < minEvents) continue

      const duration = events.length > 1
        ? (events[events.length - 1].timestamp - events[0].timestamp) / 60000
        : 0

      results.push({
        file,
        lines: fs.readFileSync(fullPath, 'utf-8').split('\n').length,
        tool_calls: events.length,
        user_prompts: prompts.slice(0, 5),
        duration_minutes: Math.round(duration),
      })
    } catch {
      continue
    }
  }

  return results.sort((a, b) => b.tool_calls - a.tool_calls)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage:
  npx ts-node scripts/import-claude-transcript.ts <transcript.jsonl> [output.json]
  npx ts-node scripts/import-claude-transcript.ts --scan <directory>

Options:
  --scan <dir>     List sessions in a directory, sorted by tool call count
  --goal <N>       Use the Nth user prompt as the goal (default: 1)
  --min-events <N> Skip sessions with fewer than N tool calls (default: 5)

Claude Code transcript locations:
  ~/.codefuse/engine/cc/projects/<project-slug>/<session-id>.jsonl

Example:
  npx ts-node scripts/import-claude-transcript.ts --scan ~/.codefuse/engine/cc/projects/-Users-me-myproject/
  npx ts-node scripts/import-claude-transcript.ts ~/.codefuse/engine/cc/projects/-Users-me-myproject/abc123.jsonl
`)
    process.exit(0)
  }

  const minEventsIdx = args.indexOf('--min-events')
  const minEvents = minEventsIdx >= 0 ? parseInt(args[minEventsIdx + 1] || '5', 10) : 5
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

    const results = scanDirectory(dirPath, minEvents)
    console.log(`\nFound ${results.length} sessions with ${minEvents}+ tool calls in ${dirPath}\n`)

    for (const r of results.slice(0, 20)) {
      console.log(`  ${r.file}`)
      console.log(`    Tool calls: ${r.tool_calls} | Lines: ${r.lines} | Duration: ~${r.duration_minutes}min`)
      console.log(`    Prompts: ${r.user_prompts.map(p => `"${p.slice(0, 50)}"`).join(', ')}`)
      console.log()
    }
    process.exit(0)
  }

  // Import mode
  const inputFile = path.resolve(args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || '')
  const outputArg = args.find((a, i) => i > 0 && !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  const outputFile = outputArg
    ? path.resolve(outputArg)
    : inputFile.replace(/\.jsonl$/, '_drift_fixture.json')

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: File not found: ${inputFile}`)
    process.exit(1)
  }

  const sessionId = path.basename(inputFile, '.jsonl')
  const { events, prompts } = parseTranscript(inputFile)

  if (events.length === 0) {
    console.error('Error: No tool_use events found in transcript.')
    process.exit(1)
  }

  const fixture = convertToFixture(events, prompts, goalIndex, sessionId)
  fs.writeFileSync(outputFile, JSON.stringify(fixture, null, 2))

  console.log(`
✓ Imported Claude Code transcript: ${outputFile}

  Session: ${sessionId}
  Goal (prompt #${goalIndex}): "${prompts[goalIndex - 1]?.slice(0, 60) || 'unknown'}"
  Tool calls: ${events.length}
  User prompts: ${prompts.length}
  Duration: ~${events.length > 1 ? Math.round((events[events.length - 1].timestamp - events[0].timestamp) / 60000) : 0}min

Next steps:
  1. Run scorer: npx ts-node scripts/score-fixture.ts ${outputFile}
  2. Anonymize: npx ts-node scripts/anonymize-session.ts ${outputFile}
  3. Review and label drift/no-drift
`)
}

main()
