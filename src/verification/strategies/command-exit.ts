/**
 * Command Exit Verification Strategy.
 *
 * Verifies claims about command execution results.
 *
 * Verification method:
 *   1. Parse the claimed exit code from tool_response
 *   2. Compare against the actual exit code (if available in evidence)
 *   3. For "test passed" claims: check if stdout contains failure indicators
 *
 * This strategy works with post-hoc evidence: it examines what the agent
 * reported vs what the tool_response actually contains. It does NOT re-run
 * commands — it checks internal consistency of the agent's report.
 *
 * Hallucination patterns detected:
 *   - Agent says "tests passed" but stdout contains "FAIL" or non-zero exit
 *   - Agent says "command succeeded" but exit code is non-zero
 *   - Agent says "build complete" but output contains "ERROR"
 */

import type { Claim, ClaimVerdict, VerificationStrategy, ClaimType } from '../types'

/** Patterns that indicate command failure in stdout/stderr */
const FAILURE_INDICATORS = [
  /\bFAIL(ED|URE|ING)?\b/i,
  /\bERROR\b/i,
  /\bexception\b/i,
  /exit code [1-9]\d*/i,
  /\bnon-zero exit\b/i,
  /\bcommand failed\b/i,
  /\bsegmentation fault\b/i,
  /\bpanic\b/i,
  /\bAborted\b/,
]

/** Patterns that indicate test success */
const SUCCESS_INDICATORS = [
  /\bPASS(ED|ING)?\b/i,
  /\b\d+ tests? passed\b/i,
  /\ball tests passed\b/i,
  /\bsuccess(ful(ly)?)?\b/i,
  /exit code 0\b/i,
  /\b0 failures?\b/i,
  /\b0 errors?\b/i,
]

export class CommandExitStrategy implements VerificationStrategy {
  readonly supportedTypes: ClaimType[] = ['command_succeeded', 'command_failed', 'test_passed', 'test_failed']

  async verify(claim: Claim): Promise<ClaimVerdict> {
    const rawResponse = claim.evidence.raw_response ?? ''
    const claimedExitCode = claim.evidence.claimed_exit_code

    switch (claim.type) {
      case 'command_succeeded':
        return this.verifyCommandSucceeded(claim, rawResponse, claimedExitCode)
      case 'command_failed':
        return this.verifyCommandFailed(claim, rawResponse, claimedExitCode)
      case 'test_passed':
        return this.verifyTestPassed(claim, rawResponse)
      case 'test_failed':
        return this.verifyTestFailed(claim, rawResponse)
      default:
        return this.inconclusive(claim, `Unsupported claim type: ${claim.type}`)
    }
  }

  private verifyCommandSucceeded(
    claim: Claim,
    rawResponse: string,
    claimedExitCode: number | undefined
  ): ClaimVerdict {
    // If explicit exit code is available and non-zero → hallucination
    if (claimedExitCode !== undefined && claimedExitCode !== 0) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: false,
        confidence: 0.95,
        reason: `Agent claimed success but exit code is ${claimedExitCode}`,
        actual_observation: `Exit code: ${claimedExitCode}`,
        verified_at: Date.now(),
      }
    }

    // Check raw output for failure indicators
    const failureMatch = this.findFailureIndicator(rawResponse)
    if (failureMatch) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: false,
        confidence: 0.8,
        reason: `Agent claimed success but output contains failure indicator: "${failureMatch}"`,
        actual_observation: `Output contains: "${failureMatch}"`,
        verified_at: Date.now(),
      }
    }

    // No contradicting evidence found
    return {
      claim_id: claim.id,
      claim_type: claim.type,
      verified: true,
      confidence: claimedExitCode === 0 ? 0.9 : 0.6,
      reason: 'No contradicting evidence in output',
      verified_at: Date.now(),
    }
  }

  private verifyCommandFailed(
    claim: Claim,
    rawResponse: string,
    claimedExitCode: number | undefined
  ): ClaimVerdict {
    // If explicit exit code is 0 but agent claims failure → suspicious
    if (claimedExitCode === 0) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: false,
        confidence: 0.85,
        reason: 'Agent claimed failure but exit code is 0',
        actual_observation: 'Exit code: 0 (success)',
        verified_at: Date.now(),
      }
    }

    // Check for actual failure evidence
    const failureMatch = this.findFailureIndicator(rawResponse)
    if (failureMatch || (claimedExitCode !== undefined && claimedExitCode !== 0)) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: true,
        confidence: 0.85,
        reason: `Failure confirmed: ${failureMatch ?? `exit code ${claimedExitCode}`}`,
        verified_at: Date.now(),
      }
    }

    return {
      claim_id: claim.id,
      claim_type: claim.type,
      verified: true,
      confidence: 0.4,
      reason: 'Cannot confirm or deny failure claim (no exit code or failure indicators)',
      verified_at: Date.now(),
    }
  }

  private verifyTestPassed(claim: Claim, rawResponse: string): ClaimVerdict {
    if (!rawResponse) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: false,
        confidence: 0.7,
        reason: 'Agent claimed tests passed but no test output available to verify',
        actual_observation: 'Empty or missing test output',
        verified_at: Date.now(),
      }
    }

    // Check for failure indicators in test output
    const failureMatch = this.findFailureIndicator(rawResponse)
    if (failureMatch) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: false,
        confidence: 0.9,
        reason: `Agent claimed tests passed but output contains: "${failureMatch}"`,
        actual_observation: `Test output contains failure indicator: "${failureMatch}"`,
        verified_at: Date.now(),
      }
    }

    // Check for positive confirmation
    const successMatch = this.findSuccessIndicator(rawResponse)
    if (successMatch) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: true,
        confidence: 0.9,
        reason: `Test success confirmed: "${successMatch}"`,
        verified_at: Date.now(),
      }
    }

    // Ambiguous — no clear success or failure signal
    return {
      claim_id: claim.id,
      claim_type: claim.type,
      verified: true,
      confidence: 0.4,
      reason: 'No clear success or failure indicators in output',
      verified_at: Date.now(),
    }
  }

  private verifyTestFailed(claim: Claim, rawResponse: string): ClaimVerdict {
    const failureMatch = this.findFailureIndicator(rawResponse)
    if (failureMatch) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: true,
        confidence: 0.9,
        reason: `Test failure confirmed: "${failureMatch}"`,
        verified_at: Date.now(),
      }
    }

    const successMatch = this.findSuccessIndicator(rawResponse)
    if (successMatch) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: false,
        confidence: 0.8,
        reason: `Agent claimed tests failed but output indicates success: "${successMatch}"`,
        actual_observation: `Output contains: "${successMatch}"`,
        verified_at: Date.now(),
      }
    }

    return {
      claim_id: claim.id,
      claim_type: claim.type,
      verified: true,
      confidence: 0.4,
      reason: 'Cannot confirm or deny test failure (ambiguous output)',
      verified_at: Date.now(),
    }
  }

  private findFailureIndicator(output: string): string | null {
    for (const pattern of FAILURE_INDICATORS) {
      const match = output.match(pattern)
      if (match) return match[0]
    }
    return null
  }

  private findSuccessIndicator(output: string): string | null {
    for (const pattern of SUCCESS_INDICATORS) {
      const match = output.match(pattern)
      if (match) return match[0]
    }
    return null
  }

  private inconclusive(claim: Claim, reason: string): ClaimVerdict {
    return {
      claim_id: claim.id,
      claim_type: claim.type,
      verified: true,
      confidence: 0.1,
      reason: `Inconclusive: ${reason}`,
      verified_at: Date.now(),
    }
  }
}
