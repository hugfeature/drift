/**
 * ClaimChecker: extracts claims from tool_response and routes to verifiers.
 *
 * This is the core of Hallucinated Runtime State detection.
 *
 * Pipeline:
 *   RuntimeEvent (tool_call with tool_response)
 *       → ClaimExtractor (this module)
 *       → Claim[]
 *       → route to VerificationStrategy by claim.type
 *       → ClaimVerdict[]
 *       → VerificationSummary
 *
 * Claim extraction is heuristic-based in v0:
 *   - edit_file / write_file → file_written claim
 *   - bash / shell with success indicators → command_succeeded claim
 *   - bash / shell with test commands → test_passed/test_failed claim
 *   - rm / delete → file_deleted claim
 */

import type { RuntimeEvent } from '../types/event'
import type {
  Claim,
  ClaimType,
  ClaimVerdict,
  VerificationStrategy,
  VerificationSummary,
} from './types'
import { FileWriteStrategy } from './strategies/file-write'
import { CommandExitStrategy } from './strategies/command-exit'

function generateId(): string {
  return `claim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Tool name patterns for claim type classification
// ---------------------------------------------------------------------------

const FILE_WRITE_TOOLS = ['edit_file', 'write_file', 'create_file', 'Write', 'Edit']
const FILE_DELETE_TOOLS = ['rm', 'delete_file', 'remove']
const COMMAND_TOOLS = ['bash', 'shell', 'terminal', 'Bash']

const TEST_COMMAND_PATTERNS = [
  /\bnpm\s+test\b/,
  /\bnpx\s+jest\b/,
  /\bnpx\s+vitest\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bmake\s+test\b/,
  /\bnpm\s+run\s+test\b/,
]

// ---------------------------------------------------------------------------
// ClaimChecker
// ---------------------------------------------------------------------------

export interface ClaimCheckerConfig {
  /** Working directory for file verification (default: process.cwd()) */
  workingDir?: string
  /** Whether to run verification (can be disabled in replay mode) */
  enabled?: boolean
}

export class ClaimChecker {
  private strategies: Map<ClaimType, VerificationStrategy> = new Map()
  private verdicts: ClaimVerdict[] = []
  private enabled: boolean

  constructor(config?: ClaimCheckerConfig) {
    this.enabled = config?.enabled ?? true

    const fileStrategy = new FileWriteStrategy(config?.workingDir)
    const commandStrategy = new CommandExitStrategy()

    // Register strategies by their supported types
    for (const type of fileStrategy.supportedTypes) {
      this.strategies.set(type, fileStrategy)
    }
    for (const type of commandStrategy.supportedTypes) {
      this.strategies.set(type, commandStrategy)
    }
  }

  /**
   * Check a single event for hallucinated claims.
   * Only processes tool_call events with tool_response data.
   * Returns extracted verdicts (empty array if no claims found).
   */
  async check(event: RuntimeEvent): Promise<ClaimVerdict[]> {
    if (!this.enabled) return []
    if (event.type !== 'tool_call') return []

    const claims = this.extractClaims(event)
    if (claims.length === 0) return []

    const eventVerdicts: ClaimVerdict[] = []
    for (const claim of claims) {
      const strategy = this.strategies.get(claim.type)
      if (!strategy) continue

      const verdict = await strategy.verify(claim)
      eventVerdicts.push(verdict)
      this.verdicts.push(verdict)
    }

    return eventVerdicts
  }

  /**
   * Get aggregated verification summary for the session.
   */
  getSummary(): VerificationSummary {
    const verdicts = this.verdicts
    const verified = verdicts.filter(v => v.verified && v.confidence >= 0.5)
    const hallucinated = verdicts.filter(v => !v.verified && v.confidence >= 0.5)
    const inconclusive = verdicts.filter(v => v.confidence < 0.5)

    const denominator = verified.length + hallucinated.length
    const hallucinationRate = denominator > 0
      ? hallucinated.length / denominator
      : 0

    return {
      total_claims: verdicts.length,
      verified_count: verified.length,
      hallucinated_count: hallucinated.length,
      inconclusive_count: inconclusive.length,
      hallucination_rate: Math.round(hallucinationRate * 1000) / 1000,
      verdicts,
    }
  }

  /**
   * Get count of hallucinated claims (high confidence false verdicts).
   * Used as a signal input for DriftScorer.
   */
  getHallucinationCount(): number {
    return this.verdicts.filter(v => !v.verified && v.confidence >= 0.5).length
  }

  /**
   * Get all verdicts recorded so far.
   */
  getVerdicts(): ClaimVerdict[] {
    return [...this.verdicts]
  }

  // ---------------------------------------------------------------------------
  // Claim extraction
  // ---------------------------------------------------------------------------

  private extractClaims(event: RuntimeEvent): Claim[] {
    const toolName = String(event.payload['tool_name'] ?? '')
    const toolResponse = event.payload['tool_response']
    const toolInput = event.payload['tool_input'] as Record<string, unknown> | undefined
    const target = String(event.payload['target'] ?? toolInput?.['file_path'] ?? '')
    const message = String(event.payload['message'] ?? '')

    const claims: Claim[] = []

    // --- File write claims ---
    if (this.isFileWriteTool(toolName)) {
      const filePath = target || this.extractFilePathFromInput(toolInput)
      if (filePath) {
        claims.push({
          id: generateId(),
          type: 'file_written',
          assertion: `File written: ${filePath}`,
          evidence: {
            file_path: filePath,
            expected_mtime_after: event.timestamp,
          },
          timestamp: event.timestamp,
          event_id: event.id,
        })
      }
    }

    // --- File delete claims ---
    if (this.isFileDeleteTool(toolName, message)) {
      const filePath = target || this.extractFilePathFromInput(toolInput)
      if (filePath) {
        claims.push({
          id: generateId(),
          type: 'file_deleted',
          assertion: `File deleted: ${filePath}`,
          evidence: { file_path: filePath },
          timestamp: event.timestamp,
          event_id: event.id,
        })
      }
    }

    // --- Command execution claims ---
    if (this.isCommandTool(toolName)) {
      const rawResponse = this.extractRawResponse(toolResponse)
      const command = String(toolInput?.['command'] ?? message ?? '')
      const exitCode = this.extractExitCode(toolResponse)
      const isTestCommand = this.isTestCommand(command)

      if (isTestCommand) {
        // Determine if agent claims tests passed or failed based on response
        const claimType = this.inferTestOutcome(rawResponse, exitCode)
        claims.push({
          id: generateId(),
          type: claimType,
          assertion: `${claimType === 'test_passed' ? 'Tests passed' : 'Tests failed'}: ${command.slice(0, 80)}`,
          evidence: {
            command,
            claimed_exit_code: exitCode,
            test_target: command,
            raw_response: rawResponse,
          },
          timestamp: event.timestamp,
          event_id: event.id,
        })
      } else if (command) {
        // General command — check if agent claims success
        const succeeded = exitCode === undefined || exitCode === 0
        claims.push({
          id: generateId(),
          type: succeeded ? 'command_succeeded' : 'command_failed',
          assertion: `Command ${succeeded ? 'succeeded' : 'failed'}: ${command.slice(0, 80)}`,
          evidence: {
            command,
            claimed_exit_code: exitCode,
            raw_response: rawResponse,
          },
          timestamp: event.timestamp,
          event_id: event.id,
        })
      }
    }

    return claims
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isFileWriteTool(toolName: string): boolean {
    return FILE_WRITE_TOOLS.some(t =>
      toolName.toLowerCase().includes(t.toLowerCase())
    )
  }

  private isFileDeleteTool(toolName: string, message: string): boolean {
    if (FILE_DELETE_TOOLS.some(t => toolName.toLowerCase().includes(t.toLowerCase()))) {
      return true
    }
    // bash command that looks like deletion
    if (toolName.toLowerCase() === 'bash' && /\brm\s/.test(message)) {
      return true
    }
    return false
  }

  private isCommandTool(toolName: string): boolean {
    return COMMAND_TOOLS.some(t =>
      toolName.toLowerCase().includes(t.toLowerCase())
    )
  }

  private isTestCommand(command: string): boolean {
    return TEST_COMMAND_PATTERNS.some(p => p.test(command))
  }

  private extractFilePathFromInput(toolInput: Record<string, unknown> | undefined): string {
    if (!toolInput) return ''
    return String(
      toolInput['file_path'] ??
      toolInput['path'] ??
      toolInput['filename'] ??
      toolInput['target'] ??
      ''
    )
  }

  private extractRawResponse(toolResponse: unknown): string {
    if (!toolResponse) return ''
    if (typeof toolResponse === 'string') return toolResponse
    if (typeof toolResponse === 'object' && toolResponse !== null) {
      const obj = toolResponse as Record<string, unknown>
      const stdout = String(obj['stdout'] ?? '')
      const stderr = String(obj['stderr'] ?? '')
      const content = String(obj['content'] ?? '')
      return [stdout, stderr, content].filter(Boolean).join('\n')
    }
    return String(toolResponse)
  }

  private extractExitCode(toolResponse: unknown): number | undefined {
    if (!toolResponse || typeof toolResponse !== 'object') return undefined
    const obj = toolResponse as Record<string, unknown>
    const exitCode = obj['exit_code'] ?? obj['exitCode'] ?? obj['code']
    if (exitCode === undefined || exitCode === null) return undefined
    return Number(exitCode)
  }

  private inferTestOutcome(rawResponse: string, exitCode: number | undefined): 'test_passed' | 'test_failed' {
    // Exit code takes precedence
    if (exitCode !== undefined && exitCode !== 0) return 'test_failed'
    if (exitCode === 0) return 'test_passed'

    // Heuristic: look for failure keywords
    if (/\bFAIL/i.test(rawResponse)) return 'test_failed'
    if (/\bPASS/i.test(rawResponse)) return 'test_passed'

    // Default: assume passed (agent's implicit claim)
    return 'test_passed'
  }
}
