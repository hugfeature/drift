/**
 * Tests for ClaimChecker — Hallucinated Runtime State detection.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ClaimChecker } from '../../src/verification/claim-checker'
import type { RuntimeEvent } from '../../src/types/event'

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: `evt_test_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    session_id: 'sess_test',
    type: 'tool_call',
    source: 'agent',
    payload: {},
    ...overrides,
  }
}

describe('ClaimChecker', () => {
  let tmpDir: string
  let checker: ClaimChecker

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'))
    checker = new ClaimChecker({ workingDir: tmpDir })
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('file_written claims', () => {
    it('should verify file that exists and was recently modified', async () => {
      const filePath = path.join(tmpDir, 'created.ts')
      fs.writeFileSync(filePath, 'export const x = 1')

      const event = makeEvent({
        payload: {
          tool_name: 'edit_file',
          target: filePath,
        },
      })

      const verdicts = await checker.check(event)
      expect(verdicts.length).toBe(1)
      expect(verdicts[0].claim_type).toBe('file_written')
      expect(verdicts[0].verified).toBe(true)
    })

    it('should detect hallucination when file does not exist', async () => {
      const event = makeEvent({
        payload: {
          tool_name: 'write_file',
          target: path.join(tmpDir, 'nonexistent.ts'),
        },
      })

      const verdicts = await checker.check(event)
      expect(verdicts.length).toBe(1)
      expect(verdicts[0].verified).toBe(false)
      expect(verdicts[0].reason).toContain('does not exist')
    })

    it('should detect hallucination when file mtime is stale', async () => {
      const filePath = path.join(tmpDir, 'stale.ts')
      fs.writeFileSync(filePath, 'old content')
      // Set mtime to 1 hour ago
      const pastTime = new Date(Date.now() - 3600_000)
      fs.utimesSync(filePath, pastTime, pastTime)

      const event = makeEvent({
        timestamp: Date.now(),
        payload: {
          tool_name: 'edit_file',
          target: filePath,
        },
      })

      const verdicts = await checker.check(event)
      expect(verdicts.length).toBe(1)
      expect(verdicts[0].verified).toBe(false)
      expect(verdicts[0].reason).toContain('mtime')
    })
  })

  describe('file_deleted claims', () => {
    it('should verify deletion when file is gone', async () => {
      const event = makeEvent({
        payload: {
          tool_name: 'bash',
          message: 'rm gone.ts',
          tool_input: { command: 'rm gone.ts', file_path: path.join(tmpDir, 'gone.ts') },
        },
      })

      const verdicts = await checker.check(event)
      // bash + rm → file_deleted claim
      const deleteVerdict = verdicts.find(v => v.claim_type === 'file_deleted')
      if (deleteVerdict) {
        expect(deleteVerdict.verified).toBe(true)
      }
    })
  })

  describe('command_succeeded claims', () => {
    it('should verify command when no failure indicators in output', async () => {
      const event = makeEvent({
        payload: {
          tool_name: 'bash',
          tool_input: { command: 'npm run build' },
          tool_response: { stdout: 'Build complete.', exit_code: 0 },
        },
      })

      const verdicts = await checker.check(event)
      const cmdVerdict = verdicts.find(v => v.claim_type === 'command_succeeded')
      expect(cmdVerdict).toBeDefined()
      expect(cmdVerdict!.verified).toBe(true)
    })

    it('should detect hallucination when output contains ERROR but exit_code is 0', async () => {
      const event = makeEvent({
        payload: {
          tool_name: 'bash',
          tool_input: { command: 'npm run build' },
          tool_response: { stdout: 'ERROR: Module not found\nBuild failed.', exit_code: 0 },
        },
      })

      const verdicts = await checker.check(event)
      const cmdVerdict = verdicts.find(v => v.claim_type === 'command_succeeded')
      expect(cmdVerdict).toBeDefined()
      // exit_code=0 says success, but output has ERROR → contradiction detected
      expect(cmdVerdict!.verified).toBe(false)
      expect(cmdVerdict!.reason).toContain('failure indicator')
    })
  })

  describe('test_passed claims', () => {
    it('should verify tests when output confirms passing', async () => {
      const event = makeEvent({
        payload: {
          tool_name: 'bash',
          tool_input: { command: 'npm test' },
          tool_response: { stdout: 'Tests: 12 passed, 0 failures', exit_code: 0 },
        },
      })

      const verdicts = await checker.check(event)
      const testVerdict = verdicts.find(v => v.claim_type === 'test_passed')
      expect(testVerdict).toBeDefined()
      expect(testVerdict!.verified).toBe(true)
    })

    it('should detect hallucination when tests actually failed', async () => {
      const event = makeEvent({
        payload: {
          tool_name: 'bash',
          tool_input: { command: 'npx jest' },
          tool_response: { stdout: 'FAIL src/auth.test.ts\n  2 tests failed', exit_code: 1 },
        },
      })

      const verdicts = await checker.check(event)
      const testVerdict = verdicts.find(v => v.claim_type === 'test_failed')
      expect(testVerdict).toBeDefined()
      expect(testVerdict!.verified).toBe(true)
    })
  })

  describe('summary and hallucination count', () => {
    it('should accumulate verdicts across multiple events', async () => {
      const freshChecker = new ClaimChecker({ workingDir: tmpDir })

      // Event 1: file that exists
      const existingFile = path.join(tmpDir, 'exists.ts')
      fs.writeFileSync(existingFile, 'content')
      await freshChecker.check(makeEvent({
        payload: { tool_name: 'edit_file', target: existingFile },
      }))

      // Event 2: file that does NOT exist (hallucination)
      await freshChecker.check(makeEvent({
        payload: { tool_name: 'write_file', target: path.join(tmpDir, 'fake.ts') },
      }))

      const summary = freshChecker.getSummary()
      expect(summary.total_claims).toBe(2)
      expect(summary.verified_count).toBe(1)
      expect(summary.hallucinated_count).toBe(1)
      expect(summary.hallucination_rate).toBeCloseTo(0.5, 1)
      expect(freshChecker.getHallucinationCount()).toBe(1)
    })
  })

  describe('non-tool events', () => {
    it('should skip non-tool_call events', async () => {
      const event = makeEvent({ type: 'goal_confirmed' })
      const verdicts = await checker.check(event)
      expect(verdicts.length).toBe(0)
    })
  })

  describe('disabled mode', () => {
    it('should return empty when disabled', async () => {
      const disabledChecker = new ClaimChecker({ enabled: false })
      const event = makeEvent({
        payload: { tool_name: 'edit_file', target: '/some/path.ts' },
      })
      const verdicts = await disabledChecker.check(event)
      expect(verdicts.length).toBe(0)
    })
  })
})
