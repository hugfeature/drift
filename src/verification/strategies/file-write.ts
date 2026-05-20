/**
 * File Write Verification Strategy.
 *
 * Verifies claims that a file was written/created/modified.
 *
 * Verification method:
 *   1. Check if file exists at claimed path
 *   2. Check file mtime is after the event timestamp (file was recently modified)
 *   3. If file doesn't exist or mtime is stale → hallucination detected
 *
 * Limitations (v0):
 *   - Cannot verify content correctness (only existence + recency)
 *   - Requires filesystem access (won't work for remote/sandboxed agents)
 *   - Race condition: file could be deleted between write and verify
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Claim, ClaimVerdict, VerificationStrategy, ClaimType } from '../types'

/** How many milliseconds of slack to allow between event and file mtime */
const MTIME_SLACK_MS = 5000

export class FileWriteStrategy implements VerificationStrategy {
  readonly supportedTypes: ClaimType[] = ['file_written', 'file_deleted']

  private workingDir: string

  constructor(workingDir?: string) {
    this.workingDir = workingDir ?? process.cwd()
  }

  async verify(claim: Claim): Promise<ClaimVerdict> {
    const filePath = claim.evidence.file_path
    if (!filePath) {
      return this.inconclusive(claim, 'No file_path in claim evidence')
    }

    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workingDir, filePath)

    if (claim.type === 'file_written') {
      return this.verifyFileWritten(claim, resolvedPath)
    }

    if (claim.type === 'file_deleted') {
      return this.verifyFileDeleted(claim, resolvedPath)
    }

    return this.inconclusive(claim, `Unsupported claim type: ${claim.type}`)
  }

  private verifyFileWritten(claim: Claim, resolvedPath: string): ClaimVerdict {
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolvedPath)
    } catch {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: false,
        confidence: 0.9,
        reason: `File does not exist: ${resolvedPath}`,
        actual_observation: 'File not found on filesystem',
        verified_at: Date.now(),
      }
    }

    // Check if mtime is recent relative to the claim timestamp
    const mtimeMs = stat.mtimeMs
    const claimTime = claim.evidence.expected_mtime_after ?? claim.timestamp
    const isRecent = mtimeMs >= claimTime - MTIME_SLACK_MS

    if (isRecent) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: true,
        confidence: 0.85,
        reason: `File exists and was modified at ${new Date(mtimeMs).toISOString()} (after claim time)`,
        verified_at: Date.now(),
      }
    }

    return {
      claim_id: claim.id,
      claim_type: claim.type,
      verified: false,
      confidence: 0.75,
      reason: `File exists but mtime (${new Date(mtimeMs).toISOString()}) is before claim time (${new Date(claimTime).toISOString()})`,
      actual_observation: `File last modified at ${new Date(mtimeMs).toISOString()}, claim was at ${new Date(claimTime).toISOString()}`,
      verified_at: Date.now(),
    }
  }

  private verifyFileDeleted(claim: Claim, resolvedPath: string): ClaimVerdict {
    const exists = fs.existsSync(resolvedPath)

    if (!exists) {
      return {
        claim_id: claim.id,
        claim_type: claim.type,
        verified: true,
        confidence: 0.9,
        reason: 'File does not exist (deletion confirmed)',
        verified_at: Date.now(),
      }
    }

    return {
      claim_id: claim.id,
      claim_type: claim.type,
      verified: false,
      confidence: 0.85,
      reason: 'File still exists after claimed deletion',
      actual_observation: 'File is present on filesystem',
      verified_at: Date.now(),
    }
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
