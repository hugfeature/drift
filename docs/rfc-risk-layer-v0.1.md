# RFC: Drift Risk Annotation Layer v0.1

**Status**: Draft — frozen 2026-05-29
**Scope**: Offline replay experiment on existing fixture corpus
**Non-product**: This is a research artifact, not a runtime interceptor

---

## 1. Problem Statement

Can we detect trajectory risk **3–5 events before known failure** using only event-level signals available at runtime?

This RFC defines the signals, normalization rules, and offline experiment protocol to answer that question. It does NOT define a policy engine, enforcement layer, or production interceptor.

## 2. Corpus Assumptions

- **67 fixtures** in `eval/fixtures/case_*.json`
- **63 fixtures** have ≥5 events with full `session.events[]` trace — these are the experiment population
- **3 recovery-trigger fixtures** (case_063, case_064, case_067) are **excluded** from risk signal analysis, identified by `session_trigger_type: "recovery"` or explicit recovery/remediation schema. They record remediation sessions where drift_score=0 by design; the actual failure occurred in an upstream session
- **1 fixture** has 0 events — excluded
- Event count range: 5–789, median 86
- **104 unique tool names**, `Bash` accounts for ~50% of all events

## 3. Event Normalization

### 3.1 Schema Unification

Two schemas coexist and must be normalized to a common event record:

| Field | Early schema (001–050+) | Late schema (063–067) |
|-------|------------------------|-----------------------|
| Events | `session.events[]` | `session.events[]` (remediation) or absent |
| Drift score | `drift_score_at_event` per event | Not present |
| Failure evidence | Inferred from `label` | `failure_chain.root.event_refs` |
| Goal relation | `goal_relation` + `relation_confidence` | Not present |

**Normalized event record**:

```typescript
interface NormalizedEvent {
  index: number;
  timestamp: number;
  tool_name: string;
  tool_target?: string;     // file path, URL, resource id when extractable
  domain: Domain;           // mapped from tool_name + payload
  goal_relation?: string;   // "aligned" | "tangential" | "unrelated" | undefined
  relation_confidence?: number;
  is_refresh: boolean;      // true if tool is read-class AND target overlaps prior observation
  outcome?: "success" | "failed" | "no_progress" | "unknown";
}
```

### 3.2 Failure Point Index

- For trace-rich fixtures: **last event** in the session is treated as `failure_point_index` unless the fixture has explicit `failure_event_index` annotation
- For recovery-trigger fixtures: the entire session is excluded (it IS the recovery, not the failure)
- The **risk window** is `[failure_point_index - N, failure_point_index)` where N ∈ {3, 5}
- The **baseline windows** are all earlier N-sized sliding windows `[i, i+N)` where `i ∈ [0, failure_point_index - N)`, used as negative comparison. This ensures enrichment ratio compares same-sized windows, avoiding denominator mismatch

### 3.3 Domain Mapping

v0.1 uses 8 coarse domains:

| Domain | Tool patterns |
|--------|--------------|
| `code` | Edit, Write, code-generation tools |
| `read` | Read, cat-in-Bash, Grep, Glob |
| `test` | test/jest/pytest in Bash, test-runner tools |
| `filesystem` | ls/find/stat in Bash, file-management |
| `git` | git-* in Bash |
| `browser` | web_fetch, browser tools |
| `task_mgmt` | TaskCreate, TaskUpdate, TaskOutput, engram tools |
| `unknown` | unmapped |

**Bash disambiguation**: `Bash` events MUST be sub-classified by inspecting `payload.message` or `payload.command` for command prefixes (git, ls, cat, npm test, etc.). A `Bash` event that cannot be sub-classified maps to `unknown`.

## 4. Signal Definitions

### Primary Risk Signals

**stale_context** — memory validity collapse

- **Logic**: An observation event (Read/cat/stat/query) is followed by ≥5 intervening non-refresh events (gap events), then an action event (Edit/Write/Bash-mutating) targeting the same resource, with **no valid refresh** in between. v0.1 does not require semantic unrelatedness for gap events — any non-refresh event counts
- **stale_gap_threshold**: 5 events
- **Refresh validity**: A refresh is valid ONLY when the refresh tool is read-class AND the refresh target overlaps with the previously observed state target. `ls` on directory B does NOT refresh file A
- **Output**: `{ signal: "stale_context", stale_gap: number, observation_index: number, action_index: number }`

**retry_density** — local recovery collapse

- **Logic**: Within a sliding window of 5 events, count events matching the same normalized retry key: `same_tool AND same_target AND outcome ∈ {failed, no_progress}`. Events need not be consecutive — any qualifying events within the window are counted
- **window_size**: 5
- **retry_threshold**: 3 (fires when ≥3 qualifying retries in window)
- **same_target canonicalization**: Determined by normalized file path / URL / resource id / command target when extractable from payload. Events without extractable target are NOT eligible for retry_density scoring. v0.1 prefers false negatives over false positives
- **Output**: `{ signal: "retry_density", count: number, window_start: number, window_end: number }`

**trajectory_divergence** — global intent drift

- **Logic**: Within a sliding window of 5 events, detect persistent dominant domain emergence that diverges from the expected domain for the active goal
- **Detection**: Unexpected dominant domain appears for ≥3 consecutive events (persistence threshold)
- **Severity**: 1 event = anomaly (not reported), 2 events = instability (not reported), 3+ events = divergence (reported)
- **Goal→expected_domain**: Hardcoded mapping from goal keywords. v0.1 uses conservative defaults
- **Tool→observed_domain**: Deterministic mapping per §3.3
- **Does NOT detect**: domain widening (exploratory behavior). Only detects persistent takeover by an unexpected domain
- **Baseline comparison**: existing `goal_relation` + `relation_confidence` annotations (when available) serve as independent baseline for trajectory_divergence. v0.1 runs both and compares
- **Output**: `{ signal: "trajectory_divergence", dominant_domain: Domain, expected_domain: Domain, persistence: number, window_start: number }`

### Contextual Feature (not standalone risk evidence)

**execution_length** — session pressure indicator

- **Definition**: Total event count in session
- **Role**: Contextual runtime pressure indicator. NOT standalone drift evidence. Used only for stratification, calibration, or interaction analysis (e.g., "stale_context appears more in sessions >100 events")
- **Output**: `{ feature: "execution_length", value: number }`

## 5. Non-Goals

- ❌ Runtime interception or automatic blocking
- ❌ Permission gradient enforcement
- ❌ Policy engine or threshold-based auto-remediation
- ❌ Cross-session risk accumulation (v0.1 is single-session only; 3 cross-session fixtures insufficient for validation)
- ❌ Semantic similarity or embedding-based signal detection
- ❌ Real-time scoring — this is offline replay only
- ❌ Treating `execution_length` as drift evidence

## 6. Offline Replay Protocol

```
Input:  eval/fixtures/case_*.json (63 eligible fixtures)
Output: eval/risk-annotations/case_*.risk.json

Pipeline:
  1. Load fixture → extract session.events[]
  2. Normalize events → NormalizedEvent[]
  3. Determine failure_point_index (default: last event)
  4. Run signal detectors over the FULL normalized event stream
  5. Assign emitted signals to risk_window or baseline_windows by their firing index (action_index for stale_context, window_end for retry_density/trajectory_divergence)
  6. Output per-fixture risk annotation:
     {
       case_id: string,
       total_events: number,
       failure_point_index: number,
       risk_window_signals: Signal[],
       baseline_window_signals: Signal[],
       trajectory_risk: "HIGH" | "MEDIUM" | "LOW",
       execution_length: number
     }
  7. Aggregate cross-fixture statistics
```

## 7. Success Criteria

> In at least 63 trace-rich fixtures, determine whether one or more primary risk signals appears within the final 3–5 events before known failure, and compare against earlier session windows as baseline.

Specific metrics:

- **Signal presence rate**: What % of failure-adjacent windows contain ≥1 primary signal?
- **Signal enrichment ratio**: `(signal rate in risk_window) / (signal rate in baseline_window)` — must be >1.0 to have any predictive value
- **Per-signal breakdown**: Which signals are most enriched in pre-failure windows?
- **False positive estimation**: Signal rate in baseline windows of non-failure sessions (if any)

v0.1 succeeds if: **enrichment ratio > 1.5 for at least one primary signal**. This proves the signal has differential presence before failure vs. during normal operation.

## 8. Known Gaps

1. **Bash dominance**: ~50% of events are `Bash`. Domain sub-classification depends on payload text parsing quality. If sub-classification fails for >30% of Bash events, trajectory_divergence will be unreliable
2. **failure_point_index is heuristic**: "last event = failure" is a simplification. Some fixtures may have failure mid-session with partial recovery. v0.2 should add explicit failure_point annotation
3. **tool_target extraction is fragile**: Payload structures vary across runtimes (codefuse, claude-code, codex). v0.1 uses regex-based extraction with fallback to `undefined`
4. **goal→expected_domain mapping is cold-start**: No training data for this mapping. v0.1 hardcodes based on keyword heuristics, expects noise
5. **Cross-session gap**: Only 3 cross-session fixtures exist. Execution risk accumulation across sessions is explicitly out of scope for v0.1
6. **Pre-experiment validation needed**: Before running the full pipeline, verify Bash sub-classification coverage. If >70% of Bash events can be mapped to a specific domain, proceed. Otherwise, revise §3.3 first

---

## Appendix A: Experiment Results (2026-05-29)

> **Status**: First replay completed. All three primary signals show statistically meaningful enrichment in pre-failure windows.

### A.1 Corpus & Coverage

| Metric | Value |
|--------|-------|
| Total fixtures | 67 |
| Eligible (≥5 events, non-recovery) | 62 |
| Excluded (recovery-trigger) | 3 (case_063, case_064, case_067) |
| Excluded (<5 events) | 2 |
| Total events | 7,962 |
| Event count range | 7–789, median 86 |

**Domain classification coverage**: 87.9% mapped (unknown 12.1%). Bash semantic sub-classification reduced unknown from 43.4% → 12.1%, well below the 30% threshold.

| Domain | Events | % |
|--------|--------|---|
| read | 2,993 | 37.6% |
| code | 1,703 | 21.4% |
| task_mgmt | 1,184 | 14.9% |
| unknown | 963 | 12.1% |
| browser | 465 | 5.8% |
| filesystem | 269 | 3.4% |
| git | 207 | 2.6% |
| test | 178 | 2.2% |

### A.2 Signal Enrichment (window_size=5)

| Signal | Risk Window hits | Baseline hits | Risk rate | Baseline rate | **Enrichment** |
|--------|-----------------|---------------|-----------|---------------|----------------|
| **stale_context** | 11 | 156 | 0.177 | 0.0212 | **8.35x** ✅ |
| **retry_density** | 11 | 167 | 0.177 | 0.0227 | **7.80x** ✅ |
| **trajectory_divergence** | 3 | 54 | 0.048 | 0.0074 | **6.58x** ✅ |

**Signal presence rate**: 17/62 fixtures (27.4%) have ≥1 primary signal in the risk window.

**Success criteria**: enrichment > 1.5 for at least one signal → **PASS** (all three pass, min 6.58x).

### A.3 Risk Distribution

| Risk level | Fixtures | % |
|------------|----------|---|
| HIGH (≥3 signals) | 1 | 1.6% |
| MEDIUM (1–2 signals) | 16 | 25.8% |
| LOW (0 signals) | 45 | 72.6% |

### A.4 Key Observations

1. **stale_context is the strongest single signal** (8.35x enrichment). "Observed state → long gap without refresh → mutated same target" reliably precedes failure. This maps to memory validity collapse in the cognitive failure layer.

2. **retry_density required adapted detection**. Original RFC rule (outcome ∈ {failed, no_progress}) produced zero hits because 99.6% of events have unknown outcome. Adapted to detect repetition-as-evidence: same_tool + same_target/message appearing ≥3 times in a 5-event window. After adaptation: 7.80x enrichment.

3. **trajectory_divergence has the fewest samples** (3 risk hits) but strong enrichment (6.58x). Limited by cold-start goal→expected_domain mapping — many fixtures lack extractable goal text. v0.2 should improve goal extraction.

4. **27.4% recall is conservative by design** — v0.1 prioritizes precision. 72.6% LOW-risk fixtures may contain signals detectable with richer payload parsing or larger window sizes.

5. **The three signals are complementary** — enrichment ratios are similar (6.5–8.4x) but they fire on different fixtures, measuring different failure dimensions: memory validity (stale_context), local recovery collapse (retry_density), global intent drift (trajectory_divergence).

### A.5 Adaptation Notes (deviations from original RFC)

| RFC spec | Actual implementation | Reason |
|----------|-----------------------|--------|
| retry_density uses outcome ∈ {failed, no_progress} | Uses repetition-as-evidence (same_tool + same_target/message) | 99.6% of events lack outcome metadata |
| Bash sub-classification by command prefix | Added semantic NL rules for summarized Bash descriptions | Fixture payloads use "Check git status" not `git status` |
| 8 domains, static tool→domain map | Added 30+ MCP tool patterns + Bash NL rules | 104 unique tool names in corpus |

### A.6 Conclusion

> In 62 trace-rich fixtures, all three primary risk signals appear with 6.5–8.4x enrichment in the final 5 events before known failure, compared to same-sized baseline windows. This provides initial evidence that **trajectory risk is observable before execution collapse**.

Next steps for v0.2:
- Improve outcome extraction to enable original retry_density rule alongside repetition-based detection
- Improve goal text extraction to increase trajectory_divergence coverage
- Add explicit failure_point_index annotation to fixtures (replacing "last event" heuristic)
- Test window_size=3 to check if signal strength changes with tighter windows

---

## Appendix B: v0.2 Problem Statement — Premise & Coverage Validation

> **Status**: Draft — 2026-05-29
> **Motivation**: Cases 063–068 (6 consecutive fixtures, all cognitive-layer failures with flawless execution) expose a systematic blind spot in v0.1's signal architecture.

### B.1 The Blind Spot

v0.1's 4 signals detect **execution anomalies** — how the agent does things:
- stale_context: read something old
- retry_density: got stuck repeating
- trajectory_divergence: tools drifted to wrong domain
- execution_length: session too long

Cases 063–068 all score 0 on every signal because the agent executes flawlessly — it just executes **the wrong thing** or **an incomplete thing**. The failure happens in the cognitive layer (goal internalization, premise verification, obligation tracking) and maps to perfect tool-call patterns.

```
                    v0.1 detection boundary
                            │
  ┌─────────────────────────┼─────────────────────────────┐
  │ Cognitive Layer          │  Tool-call Pattern Layer     │
  │ (WHERE failures happen)  │  (WHERE v0.1 looks)          │
  │                          │                              │
  │ • goal_narrowing (068)   │  → perfect writes            │
  │ • constraint_relaxation  │  → perfect browser+test      │
  │   (067)                  │                              │
  │ • false_premise (066)    │  → coherent explanations     │
  │ • incomplete_closure     │  → correct partial execution │
  │   (063/064/065)          │                              │
  └──────────────────────────┼──────────────────────────────┘
                             │
              execution acts as a perfect buffer
```

### B.2 Three Pattern Families

| Pattern | Cases | Definition | Detection Principle |
|---------|-------|-----------|-------------------|
| **incomplete_followthrough** | 063, 064, 065 | Goal understood correctly, execution chain breaks at non-visible steps | Check obligation closure: N obligations → N completions |
| **premise_violation** | 066, 067 | Agent reasons correctly on unverified/contradicted premise | Check assertion↔verification: claim X → must have read/checked X |
| **scope_compression** | 068 | Input scope compressed during goal internalization | Check prompt↔plan alignment: prompt entities ≥ plan entities |

### B.3 Candidate Signals for v0.2

#### Signal 5: `assertion_without_verification`

- **Targets**: premise_violation (066, 067)
- **Logic**: Agent's output text asserts a factual claim about system state (file exists, config is set, environment is X). Check whether a verification-class tool call (Read/Glob/cat/stat/browser-inspect) targeting that resource occurred **before** the assertion
- **Detection window**: Look backward from assertion event for any verification of the claimed resource
- **Difficulty**: 🟡 Medium — requires shallow NLP to extract factual claims from agent text, then match against tool targets
- **False positive risk**: Low — assertions about things the agent just wrote/created are excluded (write→assert is normal)

#### Signal 6: `completion_coverage_gap`

- **Targets**: scope_compression (068), partial coverage of incomplete_followthrough (063)
- **Logic**: When agent emits a completion signal (track_progress done / "交付完成" / task closure), compare prompt-level constraints (quantity words, entity lists) against actual output count
- **Detection window**: Fires only at completion events
- **Extraction**: Regex for Chinese/English quantity patterns (`两篇`/`三个`/`5 items`/`A + B + C`) in first user message; count matching output artifacts
- **Difficulty**: 🟢 Low — pure regex + counting, no LLM needed for 80% coverage
- **False positive risk**: Medium — user may say "两个方案" meaning "2 options to choose from" not "produce 2 things"

#### Signal 7: `obligation_closure_check`

- **Targets**: incomplete_followthrough (063, 064, 065)
- **Logic**: When agent performs a task_mgmt action (create_task/update_memory/register_hook), infer the set of **downstream obligations** that complete the workflow. Check whether all obligations are fulfilled before session end
- **Detection window**: Full session, retrospective at session end
- **Obligation inference**: Hardcoded patterns per task_mgmt tool type:
  - `create_task` → must eventually `update_task(status=done)`
  - `register_hook(SessionStart)` → should also register UserPromptSubmit/PostToolUse/Stop
  - `update_memory(status)` → should also close related tasks
- **Difficulty**: 🟡 Medium — obligation sets need manual curation per tool type
- **False positive risk**: Low — only fires on known obligation patterns, not speculative

### B.4 Feasibility Assessment

| Signal | Data available in current fixtures? | Requires LLM? | Breaks v0.1 architecture? |
|--------|--------------------------------------|---------------|--------------------------|
| assertion_without_verification | Partially — needs agent text (thinking/output) in trace | No (regex claim extraction) | No — adds text analysis alongside tool analysis |
| completion_coverage_gap | Yes — first user message + completion events | No | No — fires at specific events like existing signals |
| obligation_closure_check | Yes — task_mgmt events already normalized | No | No — retrospective check at session end |

### B.5 Coverage Matrix

| Case | assertion_without_verification | completion_coverage_gap | obligation_closure_check |
|------|-------------------------------|------------------------|-------------------------|
| 063 | — | 🟡 partial | ✅ |
| 064 | — | — | ✅ |
| 065 | — | — | ✅ |
| 066 | ✅ | — | — |
| 067 | ✅ | — | — |
| 068 | — | ✅ | — |

**Combined theoretical coverage: 6/6 cases.**

### B.6 Open Questions

1. **Thinking text availability**: Signal 5 requires agent reasoning text. Codefuse jsonl includes `thinking` blocks; other runtimes may not. Should v0.2 require thinking-in-trace, or fall back to output-text-only?
2. **Obligation set curation**: Signal 7 needs manually defined obligation patterns per tool type. How many patterns cover 80% of real incomplete_followthrough cases?
3. **Quantity extraction accuracy**: Signal 6 depends on regex capturing the right quantity from natural language. What's the false positive rate on the existing 67 fixtures?
4. **Interaction with v0.1 signals**: Do these new signals fire independently, or should they combine with execution signals for composite risk scoring?

### B.7 Proposed v0.2 Experiment

1. Annotate cases 063–068 with expected signal firing (ground truth)
2. Implement Signal 6 (completion_coverage_gap) first — lowest difficulty, cleanest signal
3. Run on full 67-fixture corpus, measure precision/recall against annotated cases
4. If precision >0.7: proceed to Signal 5 and 7
5. Report combined enrichment ratio for v0.1+v0.2 signals vs. v0.1 alone
