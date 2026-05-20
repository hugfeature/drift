/**
 * LangSmith Hello World — verify connectivity.
 *
 * Sends a single traced run to LangSmith dashboard.
 *
 * Prerequisites:
 *   export LANGCHAIN_API_KEY="ls-..."
 *   export LANGCHAIN_TRACING_V2="true"
 *   export LANGCHAIN_PROJECT="drift-dev"   # optional, defaults to "default"
 *
 * Run:
 *   npx ts-node scripts/langsmith-hello.ts
 *
 * Expected output:
 *   ✓ Run created: <run_id>
 *   ✓ Check LangSmith dashboard → project "drift-dev"
 */

import { Client } from 'langsmith'
import { traceable } from 'langsmith/traceable'

async function run(): Promise<void> {
  // Verify API key is set
  const apiKey = process.env.LANGCHAIN_API_KEY
  if (!apiKey) {
    console.error('ERROR: LANGCHAIN_API_KEY not set.')
    console.error('  export LANGCHAIN_API_KEY="ls-..."')
    console.error('  export LANGCHAIN_TRACING_V2="true"')
    process.exit(1)
  }

  const projectName = process.env.LANGCHAIN_PROJECT || 'drift-dev'

  // Method 1: Direct Client — create a run manually
  const client = new Client()

  console.log(`Connecting to LangSmith (project: ${projectName})...\n`)

  // Create a parent run representing a drift scoring session
  const parentRunId = crypto.randomUUID()
  await client.createRun({
    id: parentRunId,
    name: 'drift-scoring-session',
    run_type: 'chain',
    project_name: projectName,
    inputs: {
      goal: 'fix README typo',
      agent: 'claude-code',
      session_start: new Date().toISOString(),
    },
  })

  // Create a child run representing a single tool call event
  const childRunId = crypto.randomUUID()
  await client.createRun({
    id: childRunId,
    name: 'tool-call-event',
    run_type: 'tool',
    project_name: projectName,
    parent_run_id: parentRunId,
    inputs: {
      tool_name: 'read_file',
      target: 'README.md',
      goal_relation: 'aligned',
    },
  })

  // End child run with output
  await client.updateRun(childRunId, {
    outputs: {
      drift_score: 0.12,
      status: 'aligned',
      semantic_divergence: 0.08,
    },
    end_time: Date.now(),
  })

  // End parent run with final drift assessment
  await client.updateRun(parentRunId, {
    outputs: {
      final_drift_score: 0.12,
      final_status: 'aligned',
      takeover_recommended: false,
      narrative: 'Agent read README.md — aligned with goal "fix README typo"',
    },
    end_time: Date.now(),
  })

  console.log(`✓ Parent run created: ${parentRunId}`)
  console.log(`✓ Child run created:  ${childRunId}`)
  console.log(`\n✓ Check LangSmith dashboard → project "${projectName}"`)
  console.log(`  https://smith.langchain.com/`)

  // Method 2: traceable wrapper — simpler API for function tracing
  const scoreDriftEvent = traceable(
    async (event: { tool: string; target: string; goal: string }) => {
      // Simulate drift scoring
      const score = event.tool === 'read_file' && event.target.includes('README') ? 0.1 : 0.7
      return {
        drift_score: score,
        status: score < 0.5 ? 'aligned' : 'drifting',
        event_summary: `${event.tool} on ${event.target}`,
      }
    },
    { name: 'score_drift_event', project_name: projectName }
  )

  const traceableResult = await scoreDriftEvent({
    tool: 'read_file',
    target: 'README.md',
    goal: 'fix README typo',
  })

  console.log(`\n✓ Traceable function result:`, traceableResult)
  console.log(`\nDone. Both Client API and traceable wrapper verified.`)
}

run().catch(err => {
  console.error('LangSmith hello world failed:', err.message)
  process.exit(1)
})
