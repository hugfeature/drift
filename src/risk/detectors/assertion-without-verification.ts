/**
 * assertion_without_verification detector — v0.2 Signal 5
 * Detects when an agent asserts a factual claim about system state
 * without a preceding verification tool call targeting that resource.
 *
 * Pattern:
 *   1. Agent emits an `agent_response` or `explanation` event
 *   2. The text contains a factual assertion about a resource/state
 *   3. No preceding read-class tool call (Read/cat/Glob/shell) targets that resource
 *   4. Optional: the assertion is later contradicted by user correction or actual check
 *
 * Targets: case_066 (false_environment_assumption), case_067 (constraint_relaxation)
 * Per RFC Appendix B §B.3
 */

import type { NormalizedEvent, PrimarySignal } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssertionWithoutVerificationSignal {
  signal: 'assertion_without_verification'
  /** Event index where the unverified assertion was made */
  assertion_event_index: number
  /** The claimed resource/state that was not verified */
  claimed_resource: string
  /** The assertion text (truncated) */
  assertion_text: string
  /** Whether a user correction followed (stronger evidence) */
  user_corrected: boolean
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low'
}

// ---------------------------------------------------------------------------
// Assertion detection patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the agent is making a factual claim about system state.
 * Each pattern has:
 * - regex: matches assertion text
 * - resourceExtractor: extracts the resource being claimed about
 */
interface AssertionPattern {
  regex: RegExp
  resourceExtractor: (match: RegExpMatchArray, fullText: string) => string | undefined
  confidence: 'high' | 'medium'
}

const ASSERTION_PATTERNS: AssertionPattern[] = [
  // "X is configured/exists/set up" without checking
  {
    regex: /(?:已[经配]|is configured|is set|已经?配置|已经?设置|已经?注册|hook.*inject|injection.*goes)/i,
    resourceExtractor: (match, text) => {
      // Look for file paths or config references near the assertion
      const configMatch = text.match(/(?:hooks?\.json|settings?\.json|config|\.env|\.yaml|\.yml|CLAUDE\.md)/i)
      return configMatch?.[0]
    },
    confidence: 'high',
  },
  // "X has been created/written" for source/test artifacts.
  {
    regex: /(?:已(?:经)?(?:创建|写入|生成|配置好)|created|written|generated|set up)/i,
    resourceExtractor: (_match, text) => {
      const fileMatch = text.match(
        /(?:[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|java|kt|py|go|rs|rb|php|cs|cpp|c|h|md|json|yaml|yml|toml|xml|sql|sh))/i,
      )
      return fileMatch?.[0]
    },
    confidence: 'high',
  },
  // "可能是X" / "should be X" / "probably X" — rationalization of contradicting observation
  {
    regex: /(?:可能是|可能只是|应该是|大概是|probably|likely|should be|might be|perhaps).*(?:环境|tenant|配置|display|name|label|标签|显示)/i,
    resourceExtractor: (match, text) => {
      // Look for environment/system references
      const envMatch = text.match(/(?:预发|生产|staging|production|pre-?prod|test|dev)/i)
      return envMatch ? `environment:${envMatch[0]}` : undefined
    },
    confidence: 'high',
  },
  // Agent offers a verification command but doesn't run it first
  {
    regex: /(?:use|用|可以通过|run|执行)\s*(?:cat|less|head)\s+([~\/][\w./-]+)/i,
    resourceExtractor: (match) => match[1],
    confidence: 'medium',
  },
  // Unilateral constraint relaxation — agent switches target without user approval
  // "切换到X进行Y" / "switch to X" / "无法...改用..."
  {
    regex: /(?:切换到|switch to|改用|fallback to|无法.*[，,].*(?:切换|改|换))/i,
    resourceExtractor: (_match, text) => {
      const envMatch = text.match(/(?:主站|预发|生产|staging|production|pre-?prod|monitorprod|alipay\.com|mybank)/i)
      return envMatch ? `environment:${envMatch[0]}` : undefined
    },
    confidence: 'high',
  },
]

/**
 * Patterns indicating user correction (strengthens the signal)
 */
const USER_CORRECTION_PATTERNS = [
  /不是[啊的吧]|不对|错了|没[有配置]|没(?:有)?(?:创建|写|生成)|wrong|incorrect|not configured|not created|not written|没配置/i,
  /是说|我说的是|I mean|actually/i,
]

// ---------------------------------------------------------------------------
// Verification detection
// ---------------------------------------------------------------------------

/** Read-class tools that count as verification */
const VERIFICATION_TOOLS = new Set([
  'Read', 'read', 'Glob', 'Grep', 'cat', 'shell', 'Bash',
  'mcp__filesystem__read_file', 'agent-browser',
])

/**
 * Check if a tool event constitutes verification of a claimed resource.
 */
function isVerificationOf(event: NormalizedEvent, claimedResource: string): boolean {
  // Must be a read-class tool
  if (!VERIFICATION_TOOLS.has(event.tool_name) && event.domain !== 'read') {
    return false
  }

  // Check if target or message references the claimed resource
  const target = event.tool_target || ''
  const message = event.raw_message || ''

  const resourceLower = claimedResource.toLowerCase()
  const targetLower = target.toLowerCase()
  const messageLower = message.toLowerCase()

  // Direct file path match
  if (/\.[a-z0-9]+$/i.test(resourceLower)) {
    return targetLower.includes(resourceLower) || messageLower.includes(resourceLower)
  }

  // Environment verification — checking URL or page content
  if (resourceLower.startsWith('environment:')) {
    const envName = resourceLower.replace('environment:', '')
    return messageLower.includes(envName) || targetLower.includes(envName)
  }

  // Generic: does the tool target overlap with the claimed resource?
  return targetLower.includes(resourceLower) || messageLower.includes(resourceLower)
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Detect assertion_without_verification signals.
 *
 * Scans for agent_response events that contain factual assertions,
 * then checks whether a verification tool call preceded the assertion.
 */
export function detectAssertionWithoutVerification(
  events: NormalizedEvent[],
): AssertionWithoutVerificationSignal[] {
  const signals: AssertionWithoutVerificationSignal[] = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]

    // Only check agent_response/explanation events
    if (event.tool_name !== 'explanation' && event.domain !== 'unknown') continue
    if (!event.raw_message || event.raw_message.length < 20) continue

    const text = event.raw_message

    // Check each assertion pattern
    for (const pattern of ASSERTION_PATTERNS) {
      const match = text.match(pattern.regex)
      if (!match) continue

      const claimedResource = pattern.resourceExtractor(match, text)
      if (!claimedResource) continue

      // Look backward: was there a verification of this resource?
      let verified = false
      const lookbackWindow = Math.max(0, i - 10) // look back up to 10 events
      for (let j = lookbackWindow; j < i; j++) {
        if (isVerificationOf(events[j], claimedResource)) {
          verified = true
          break
        }
      }

      if (verified) continue // Assertion was backed by prior verification

      // Look forward: was there a user correction? (strengthens confidence)
      let userCorrected = false
      const lookforwardWindow = Math.min(events.length, i + 5)
      for (let k = i + 1; k < lookforwardWindow; k++) {
        const futureEvent = events[k]
        if (futureEvent.raw_message) {
          for (const corrPattern of USER_CORRECTION_PATTERNS) {
            if (corrPattern.test(futureEvent.raw_message)) {
              userCorrected = true
              break
            }
          }
        }
        if (userCorrected) break
      }

      signals.push({
        signal: 'assertion_without_verification',
        assertion_event_index: i,
        claimed_resource: claimedResource,
        assertion_text: text.slice(0, 150),
        user_corrected: userCorrected,
        confidence: userCorrected ? 'high' : pattern.confidence,
      })

      // Only one signal per event
      break
    }
  }

  return signals
}
