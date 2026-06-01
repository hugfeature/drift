/**
 * Tests for RabbitHoleDetector — behavioral pathology detection.
 *
 * Rabbit hole = the agent keeps working on the right thing but never converges:
 * repeating the same targets, exploring without editing, novelty decaying.
 * These signals are purely behavioral (no goal/embedding dependency), which
 * makes the detector deterministic and cheap to test.
 */

import { RabbitHoleDetector } from '../../src/scoring/rabbit-hole-detector'
import type { RuntimeEvent } from '../../src/types/event'

let eventCounter = 0

function makeToolEvent(
  toolName: string,
  filePath?: string,
  extra?: Record<string, unknown>,
): RuntimeEvent {
  eventCounter += 1
  const toolInput: Record<string, unknown> = { ...extra }
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

function makeNonToolEvent(): RuntimeEvent {
  eventCounter += 1
  return {
    id: `evt_${eventCounter}`,
    timestamp: 1_700_000_000_000 + eventCounter * 1000,
    session_id: 'sess_test',
    // anything other than 'tool_call' is filtered out by the detector
    type: 'goal_created',
    source: 'human',
    payload: { message: 'hello' },
  }
}

describe('RabbitHoleDetector', () => {
  let detector: RabbitHoleDetector

  beforeEach(() => {
    eventCounter = 0
    detector = new RabbitHoleDetector()
  })

  describe('insufficient data guard', () => {
    it('returns null when tool events are below minimumEvents threshold', () => {
      const events = Array.from({ length: 5 }, (_, i) =>
        makeToolEvent('read', `src/file_${i}.ts`),
      )

      expect(detector.detect(events)).toBeNull()
    })

    it('ignores non-tool events when counting toward the minimum', () => {
      const events = [
        ...Array.from({ length: 10 }, () => makeNonToolEvent()),
        ...Array.from({ length: 5 }, (_, i) =>
          makeToolEvent('read', `src/file_${i}.ts`),
        ),
      ]

      expect(detector.detect(events)).toBeNull()
    })
  })

  describe('rabbit hole signature', () => {
    it('flags high rabbit_hole_score when the agent loops on the same files without editing', () => {
      const loopedFiles = ['src/runtime.ts', 'src/loader.ts', 'src/index.ts']
      const events = Array.from({ length: 30 }, (_, i) =>
        makeToolEvent('read', loopedFiles[i % loopedFiles.length]),
      )

      const signals = detector.detect(events)

      expect(signals).not.toBeNull()
      expect(signals!.target_repetition).toBeGreaterThan(0.7)
      expect(signals!.progress_stagnation).toBe(1.0)
      expect(signals!.rabbit_hole_score).toBeGreaterThan(0.55)
    })

    it('keeps progress_stagnation low when exploration is balanced by edits', () => {
      const events: RuntimeEvent[] = []
      for (let i = 0; i < 30; i += 1) {
        const isEdit = i % 2 === 1
        events.push(makeToolEvent(isEdit ? 'edit' : 'read', `src/feature_${i}.ts`))
      }

      const signals = detector.detect(events)

      expect(signals).not.toBeNull()
      expect(signals!.progress_stagnation).toBeLessThan(0.3)
      expect(signals!.target_repetition).toBeLessThan(0.4)
      expect(signals!.rabbit_hole_score).toBeLessThan(0.55)
    })
  })

  describe('novelty decay', () => {
    it('reports zero novelty_rate when the recent window only revisits earlier targets', () => {
      const detectorWithWindow = new RabbitHoleDetector({
        windowSize: 10,
        minimumEvents: 15,
      })
      const earlyFiles = Array.from({ length: 20 }, (_, i) =>
        makeToolEvent('read', `src/early_${i}.ts`),
      )
      const revisits = Array.from({ length: 10 }, (_, i) =>
        makeToolEvent('read', `src/early_${i}.ts`),
      )

      const signals = detectorWithWindow.detect([...earlyFiles, ...revisits])

      expect(signals).not.toBeNull()
      expect(signals!.novelty_rate).toBe(0)
    })
  })
})
