/**
 * Print the current session narrative.
 * Run: npm run drift:narrative
 */

import * as fs   from 'fs'
import * as path from 'path'

const STATE_FILE = path.join(process.cwd(), '.drift-state.json')

function main(): void {
  if (!fs.existsSync(STATE_FILE)) {
    console.log('No active session. Run npm run drift:reset and start Claude Code.')
    return
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  console.log()
  console.log(`Session:  ${state.session_id}`)
  console.log(`Events:   ${state.event_count}`)
  console.log(`Goal ID:  ${state.goal_id}`)
  console.log()
  console.log('Run `npm run eval` to score this session against the benchmark.')
  console.log('To export this session as an eval fixture, use scripts/export-fixture.ts')
}

main()