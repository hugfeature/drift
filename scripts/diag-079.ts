import { loadSingleFixture } from '../src/risk/loader'
import { normalizeEvents } from '../src/risk/normalizer'
import {
  detectAssertionWithoutVerification,
  detectCompletionCoverageGap,
  detectObligationClosure,
  extractQuantityConstraints,
} from '../src/risk/detectors'

const fx = loadSingleFixture(
  '/Users/wangzhaoxian/skill/drift/eval/fixtures/case_079.json',
)
const events = normalizeEvents(fx.events)
const prompt = fx.raw.session?.goals?.[0]?.raw ?? ''

console.log('=== prompt ===')
console.log(JSON.stringify(prompt))

console.log('\n=== quantity constraints extracted ===')
console.log(extractQuantityConstraints(prompt))

console.log('\n=== normalized events ===')
for (const e of events) {
  console.log(
    `  idx=${e.index} tool=${e.tool_name} domain=${e.domain} ` +
      `target=${e.tool_target ?? ''} msg=${(e.raw_message ?? '').slice(0, 80)}`,
  )
}

console.log('\n=== assertion_without_verification ===')
console.log(JSON.stringify(detectAssertionWithoutVerification(events), null, 2))

console.log('\n=== completion_coverage_gap ===')
console.log(JSON.stringify(detectCompletionCoverageGap(events, prompt), null, 2))

console.log('\n=== obligation_closure ===')
console.log(JSON.stringify(detectObligationClosure(events), null, 2))
