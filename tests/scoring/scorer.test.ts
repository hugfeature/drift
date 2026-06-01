/**
 * Tests for DriftScorer — the core scoring algorithm.
 *
 * DriftScorer combines 8 semantic/structural signals into a single drift score
 * and a status (aligned / drifting / lost). It depends on a GoalStore for
 * goal state and an EmbeddingProvider for semantic distance.
 *
 * These tests use the default KeywordEmbeddingProvider (no network, no LLM)
 * so they stay deterministic and cheap to run in CI.
 */

import { DriftScorer } from '../../src/scoring/scorer'
import { GoalStore } from '../../src/goal/store'
import type { RuntimeEvent } from '../../src/types/event'
import type { GoalScope } from '../../src/types/goal'

let eventCounter = 0

function makeToolEvent(
  toolName: string,
  filePath?: string,
  extras?: Record<string, unknown>,
): RuntimeEvent {
  eventCounter += 1
  const toolInput: Record<string, unknown> = { ...extras }
  if (filePath) toolInput['file_path'] = filePath

  return {
    id: `evt_${eventCounter}`,
    timestamp: 1_700_000_000_000 + eventCounter * 1000,
    session_id: 'sess_test',
    type: 'tool_call',
    source: 'agent',
    payload: {
      tool_name: toolName,
      tool_input: toolInput,
    },
  }
}

function bootstrapStoreWithGoal(raw: string, scope: GoalScope): GoalStore {
  const store = new GoalStore('sess_test')
  const goal = store.create(raw)
  store.confirm(goal.id, scope)
  return store
}

describe('DriftScorer', () => {
  beforeEach(() => {
    eventCounter = 0
  })

  describe('empty / minimal input', () => {
    it('returns a well-formed aligned score when no events have been ingested', async () => {
      const store = bootstrapStoreWithGoal('Fix README typo', {
        observable_targets: ['README.md'],
        allowed_domains: ['docs'],
      })
      const scorer = new DriftScorer(store)

      const result = await scorer.score([])

      expect(result.status).toBe('aligned')
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThan(0.5)
      expect(result.signals).toBeDefined()
      expect(result.signals.semantic_divergence).toBeGreaterThanOrEqual(0)
      expect(result.signals.unauthorized_mutations).toBe(0)
      expect(result.signals.hallucinated_claims).toBe(0)
    })

    it('produces a score even when no goal is active', async () => {
      // No goal in the store — scorer must not crash and should report aligned.
      const store = new GoalStore('sess_test')
      const scorer = new DriftScorer(store)

      const result = await scorer.score([makeToolEvent('read', 'src/index.ts')])

      expect(result).toBeDefined()
      expect(result.signals).toBeDefined()
      expect(result.status).toBe('aligned')
    })
  })

  describe('aligned execution', () => {
    it('stays aligned when actions touch the goal-declared file', async () => {
      const store = bootstrapStoreWithGoal('Fix README typo', {
        observable_targets: ['README.md'],
        allowed_domains: ['docs'],
      })
      const scorer = new DriftScorer(store)

      const events = [
        makeToolEvent('read', 'README.md'),
        makeToolEvent('edit', 'README.md'),
      ]

      const result = await scorer.score(events)

      expect(result.status).toBe('aligned')
      expect(result.score).toBeLessThan(0.5)
    })
  })

  describe('signal injection', () => {
    it('reflects hallucinated_claims set externally by SessionManager', async () => {
      const store = bootstrapStoreWithGoal('Fix README typo', {
        observable_targets: ['README.md'],
        allowed_domains: ['docs'],
      })
      const scorer = new DriftScorer(store)
      scorer.setHallucinationCount(3)

      const result = await scorer.score([makeToolEvent('read', 'README.md')])

      expect(result.signals.hallucinated_claims).toBe(3)
    })
  })

  describe('output shape', () => {
    it('always returns a DriftScore with the documented fields', async () => {
      const store = bootstrapStoreWithGoal('Refactor auth module', {
        observable_targets: ['src/auth'],
        allowed_domains: ['security'],
      })
      const scorer = new DriftScorer(store)

      const result = await scorer.score([makeToolEvent('read', 'src/auth/login.ts')])

      expect(result).toEqual(
        expect.objectContaining({
          score: expect.any(Number),
          status: expect.stringMatching(/^(aligned|drifting|lost)$/),
          signals: expect.any(Object),
          computed_at: expect.any(Number),
          contributing_event_ids: expect.any(Array),
        }),
      )
      // explanation is only attached when the explanation builder has
      // something meaningful to say (e.g. signals above threshold). For an
      // aligned trace it may be undefined — we just assert the field is not
      // a broken non-object when present.
      if (result.explanation !== undefined) {
        expect(typeof result.explanation).toBe('object')
      }
    })
  })
})
