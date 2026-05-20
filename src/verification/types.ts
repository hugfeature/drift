/**
 * Verification types for Hallucinated Runtime State detection.
 *
 * Core concept: an agent makes "claims" about what happened (file written,
 * test passed, command succeeded). Verification checks whether those claims
 * match observable reality.
 *
 * Claim lifecycle:
 *   tool_response → ClaimExtractor → Claim → VerificationStrategy → ClaimVerdict
 */

/**
 * A claim is something the agent asserts happened.
 * Extracted from tool_response payloads.
 */
export interface Claim {
  /** Unique identifier */
  id: string
  /** What type of claim this is */
  type: ClaimType
  /** The agent's assertion (e.g. "file written to src/auth.ts") */
  assertion: string
  /** Structured evidence needed for verification */
  evidence: ClaimEvidence
  /** When the claim was made */
  timestamp: number
  /** Which event produced this claim */
  event_id: string
}

export type ClaimType =
  | 'file_written'
  | 'file_deleted'
  | 'command_succeeded'
  | 'command_failed'
  | 'test_passed'
  | 'test_failed'

/**
 * Structured evidence attached to a claim for verifier consumption.
 */
export interface ClaimEvidence {
  /** For file claims: the file path */
  file_path?: string
  /** For file_written: expected content hash or mtime threshold */
  expected_mtime_after?: number
  /** For command claims: the command string */
  command?: string
  /** For command claims: claimed exit code */
  claimed_exit_code?: number
  /** For test claims: test file or suite name */
  test_target?: string
  /** Raw tool_response content for fallback analysis */
  raw_response?: string
}

/**
 * Result of verifying a single claim.
 */
export interface ClaimVerdict {
  claim_id: string
  claim_type: ClaimType
  /** Whether the claim was verified as true */
  verified: boolean
  /** Confidence in the verdict (0.0 = uncertain, 1.0 = certain) */
  confidence: number
  /** Why this verdict was reached */
  reason: string
  /** When verification was performed */
  verified_at: number
  /** If not verified: what was actually observed */
  actual_observation?: string
}

/**
 * Aggregated verification result for a session window.
 */
export interface VerificationSummary {
  /** Total claims checked */
  total_claims: number
  /** Claims verified as true */
  verified_count: number
  /** Claims that failed verification (hallucinations) */
  hallucinated_count: number
  /** Claims that couldn't be checked (file gone, no access, etc.) */
  inconclusive_count: number
  /** Hallucination rate: hallucinated / (verified + hallucinated) */
  hallucination_rate: number
  /** Individual verdicts */
  verdicts: ClaimVerdict[]
}

/**
 * Interface for verification strategies.
 * Each strategy handles one or more ClaimTypes.
 */
export interface VerificationStrategy {
  /** Which claim types this strategy can verify */
  supportedTypes: ClaimType[]
  /** Verify a single claim. Returns verdict. */
  verify(claim: Claim): Promise<ClaimVerdict>
}
