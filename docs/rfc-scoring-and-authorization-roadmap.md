# RFC: Drift Scoring Trust + Dynamic Authorization Roadmap

**Status**: Draft — 2026-06-01
**Scope**: End-to-end roadmap from "trustworthy scoring" (track A) to "dynamic authorization" (track B)
**Decision log**: enforcement is **unfrozen** but gated behind track A completion; first enforcement version ships `ask` only, never `block`

---

## 0. Goal Statement

Two outcomes define "this project works":

- **Track A — Scoring fidelity**: drift scores reflect reality. A score is only credible when measured on the `strong` fixture tier.
- **Track B — Dynamic authorization**: important actions pause for user confirmation; unimportant actions proceed autonomously.

This RFC sequences A → B, because B's decision layer cannot exist without A's composite score as a reliable input. The two tracks share one seam: the **composite risk score** (stage A3).

---

## 1. Where We Are Today (2026-06-01)

### 1.1 Track A status

| Layer | Signals | Benchmark | Trust |
|-------|---------|-----------|-------|
| v0.1 execution layer | 8 semantic + 3 behavioral | P 0.727 / R 0.889 / F1 0.80 (strong tier) | credible |
| v0.2 cognitive layer | 3 new (completion_coverage / assertion_without_verification / obligation_closure) | P 100% / R 19.5%, 6/6 target cases, 0 FP | credible, narrow |

Key established truth: **raw full-corpus scores are an illusion**; only the `strong` tier (28 fixtures: imported 16 + manual 12) is trustworthy. Reports must always cite STRONG-only numbers.

### 1.2 Track B status

- `TakeoverEngine` (`src/governance/takeover.ts`) already emits structured `TakeoverRecommendation` (recommended / triggers / reasons / suggested_actions). The **decision brain exists**.
- `claude-hook.ts` hooks only **PostToolUse** (post-hoc scoring) + UserPromptSubmit (goal capture) + Stop (candidate collection). **No PreToolUse.**
- Last line of the hook is hard-coded `// Always exit 0 — never block the agent`. This is the code-level fossil of the "annotate, don't enforce" stance frozen 2026-05-29.

So B is not built from zero: it is wiring the existing takeover recommendation into a PreToolUse interception point. The starting altitude is higher than it looks — what's missing is the **hand** (interception point) and the **mouth** (confirmation loop).

---

## 2. Enforcement: Two Routes, Costs, Preconditions

The core question was: should "dynamic authorization" actually stop the agent? Two routes differ by **where interception happens relative to agent execution**.

### 2.1 Route 1 — Advisory (post-hoc, extension of current state)

Don't stop the agent; after PostToolUse scoring, surface the takeover recommendation. Agent keeps running.

- **Cost**: near zero. `takeover.ts` already produces the recommendation.
- **Precondition**: none.
- **Fatal shortcoming**: it cannot achieve the goal. "Important → ask the user" requires stopping *before* the action. Advisory can only say "it just drifted" after the fact, not "should I let it drift" before.

### 2.2 Route 2 — Enforcement (pre-execution interception)

Hook **PreToolUse**. Claude Code's PreToolUse hook supports `permissionDecision: "ask" | "deny" | "allow"` — a non-zero exit or `deny` truly blocks that tool call. This is a runtime-native enforcement point.

```
PreToolUse fires
  → Drift computes risk from trajectory-so-far
  → high risk + authorization-class action → ask/deny → agent halts → ask user
  → low risk → allow → agent proceeds autonomously
```

- **Costs**:
  1. New PreToolUse branch — but at PreToolUse the tool **hasn't executed yet**, so there is no tool_result. Signals depending on tool_result (hallucinated_claims, retry outcome) are unavailable at the interception point. Needs a **pre-execution signal subset**.
  2. Decision policy layer — risk score → `auto / ask / block` mapping + thresholds. Currently absent.
  3. Confirmation loop — how to surface the question, collect approve/reject, resume on approval.
  4. Risk: false interception of low-risk actions destroys agent UX — the original reason for the freeze.
- **Preconditions** (without these, enforcement is the "death zone"):
  1. **composite risk score must exist first** — PreToolUse needs one number, not 11 signals. (RFC §C.7 open item; track A closer.)
  2. **pre-execution signal enrichment must be re-validated** — v0.1's 8.35x enrichment was measured on full 5-event windows (with results). Interception has no future events; re-measure predictive power on history-only.
  3. **false-interception rate at the decision point** must be quantified — we have detection P/R, not "if I intercept at every PreToolUse with this threshold, how many normal actions get falsely stopped." This number sets the ask threshold.

### 2.3 Decision (confirmed 2026-06-01)

**Unfreeze enforcement, but build it only after track A closes, and ship `ask`-only first.**

- `ask` (pause + question) fully covers the goal "important → user confirmation", and misjudgment cost is bounded (at most one extra question). `block` (hard deny) misjudgment kills the agent. ask-before-block is the safe gradient.
- The freeze reason ("missing data density, unknown if thresholds are valid") is **dissolved by track A**: A produces composite score + expanded strong corpus + false-interception numbers — exactly the preconditions for unfreezing. So this is not "decide now whether to do enforcement" but "A done → preconditions met → ask route follows naturally."

---

## 3. A → B Roadmap

Stages are ordered by dependency. Each stage notes **what it unlocks**. Milestones/priorities are owner-defined.

### Stage A1 — Make scoring trust survive its sample size

- Use `claude-hook.ts` real-time capture; harden candidate fixture production (`collectCandidate` already a seed). Grow the strong tier beyond 28.
- **Do NOT** re-import legacy transcripts (ROI≈0, already verified).
- **Unlocks**: narrower confidence interval on strong-tier P/R; "scores reflect reality" goes from assertion to reproducible number.

### Stage A2 — Close cognitive-layer recall gap (v0.2 R 19.5% → higher)

- 4th cognitive signal `tool_result_provenance` (fix case_079 phantom_tool_invoke FN).
- Widen obligation pattern library (currently 3/5 variants).
- `completion_coverage_gap` regex miss analysis.
- **Unlocks**: cognitive-layer recall rises; fuller overall A coverage.

### Stage A3 — Composite risk score (A's closer, B's foundation)

- Fuse 11+ signals (v0.1 ∪ v0.2) into **one** risk number. RFC §C.7 open item.
- **Unlocks**: ① single explainable score externally; ② **B's decision layer gets its one reliable input**. This is the A/B seam.

#### A3.1 Fusion strategy — layered-max (frozen 2026-06-01)

**Decision: layered-max, not weighted-OR / weighted average.**

```
composite = max(
  v0.1_continuous_score,                 // execution-layer drift magnitude
  any_v0.2_hit ? cognitive_hit_floor : 0 // cognitive-layer hit → lift to high band
)
```

Rationale:

- v0.2 signals have **0 false positives by construction** — a single hit is board-certain cognitive-layer drift. Averaging would dilute this: a case with v0.1 score 0 but a v0.2 hit must NOT collapse to a low composite, or the recall A2 worked to recover is lost again at fusion time.
- v0.1 is a continuous score with good resolution for "drift magnitude" — keep it as-is when no cognitive signal fires.
- Each layer governs its own failure domain — whoever finds a problem wins. This is the "layered defense" framing from `rfc-risk-layer-v0.1.md` §C.5.

When v0.2 fires, composite lifts to `cognitive_hit_floor` (default **0.85**, above the lost threshold 0.75) so the zero-FP strong signal always lands in the high-risk band. When v0.2 is silent, composite degrades gracefully to the trustworthy v0.1 continuous score.

**The floor (0.85), drifting (0.45) and lost (0.75) thresholds are config-tunable** (mirrors `ScorerConfig`), to be validated/adjusted by STRONG-tier replay (stage A3 task 4). If layered-max loses precision on STRONG, fall back to weighted-OR — but with numbers, not speculation.

#### A3.2 Schema (frozen)

`CompositeRiskScore` (`src/types/composite.ts`):

```typescript
interface CompositeRiskScore {
  score: number               // final fused risk [0,1] — the one number B reads
  status: DriftStatus         // derived from score vs composite thresholds
  source: 'execution' | 'cognitive' | 'both' | 'none'
  breakdown: CompositeBreakdown   // per-layer contribution, keeps it explainable
  evidence: DriftEvidence[]       // reuses signal='composite'
  computed_at: number
}
```

Implementation lands in `src/scoring/composite.ts` (stage A3 task 2): input v0.1 `DriftScore` + v0.2 `PrimarySignal[]`, output `CompositeRiskScore`.

#### A3.3 Cognitive-hit whitelist (critical correction)

`runAllDetectors()` emits 6 signals, but only **3** are the zero-FP cognitive-layer signals validated in `rfc-risk-layer-v0.1.md` §C.2:

- `assertion_without_verification`
- `completion_coverage_gap`
- `obligation_closure_check`

The other 3 (`stale_context` / `retry_density` / `trajectory_divergence`) are **execution-layer** signals — already reflected in the v0.1 continuous score, and **not** zero-FP. Only the whitelisted 3 may lift the composite to the cognitive floor.

**Verified failure mode**: an early implementation let all 6 trigger the floor → STRONG-tier precision collapsed from 0.727 to **0.583** (10 FPs from `stale_context`/`retry_density` lifting benign sessions). Restricting to the 3-signal whitelist restored precision. This is enforced by `COGNITIVE_HIT_SIGNALS` in `composite.ts`.

#### A3.4 Replay results (2026-06-01)

Unified replay via `scripts/composite-replay.ts` — single load source `eval/fixtures/` (covers 27/28 strong; `fixtures-valid/` covers only 20). Both pipelines run per fixture, fused via layered-max, scored on the STRONG tier.

| Config | Precision | Recall | F1 |
|--------|-----------|--------|-----|
| v0.1 alone (baseline) | 0.727 | 0.889 | 0.800 |
| **composite (layered-max)** | **0.722** | **0.929** | **0.813** |

- Precision held (≈baseline) — fusion does not dilute precision.
- Recall lifted (+0.04) — cognitive-layer drift recovered.
- F1 improved (0.800 → 0.813).
- **3 cognitive-only catches** (case_063/064/065): v0.1 scored these aligned; v0.2 caught real "executed flawlessly but didn't finish" drift. This is the composite's reason for existing.

Run it: `npx ts-node scripts/composite-replay.ts` (add `--floor=0.75` to tune, `--all` for debug ALL-tier).

### Stage B1 — Decision policy layer (offline first, no runtime yet) — DONE 2026-06-01

- Define `risk score → decision` mapping + thresholds.
- Critical: **replay offline on the strong tier first** — measure false-interception rate / miss rate under this policy.
- **Unlocks**: the false-interception number — the last precondition for unfreezing enforcement, the piece missing at the 2026-05-29 freeze.

#### B1.1 Output format (frozen)

`AuthorizationVerdict` (`src/governance/policy.ts`):

```typescript
interface AuthorizationVerdict {
  decision: 'auto' | 'ask_soft' | 'ask' | 'block'  // four bands, not three
  score: number              // the composite score this verdict came from
  high_confidence: boolean   // true only in the ~0%-mis-stop band
  reason: string             // ready to show the user when asking
}
```

Why a **boolean** `high_confidence` instead of a continuous `confidence`: the false-interception rate is not continuous — it has a **cliff at 0.75** (see B1.3). We only have empirical evidence for "high-confidence band vs gray zone", so a boolean is the honest representation; a continuous confidence would imply resolution we don't have.

#### B1.2 Score → decision bands

| Composite score | Decision | Meaning |
|-----------------|----------|---------|
| `< 0.45` | `auto` | proceed autonomously |
| `0.45 – 0.75` | `ask_soft` | gray zone — optional/soft confirmation |
| `≥ 0.75` | `ask` | high-confidence — must confirm |
| (`≥ 0.95`, only if `enable_block`) | `block` | RESERVED — never emitted in v1 |

`block` stays in the type so B2 can wire it later, but `DEFAULT_POLICY_CONFIG.enable_block = false`. Frozen rationale: an `ask` misjudgment costs one extra question; a `block` misjudgment hard-kills the agent.

#### B1.3 False-interception rate (frozen metric + result)

**Definition**: false-interception rate = fraction of ground-truth-clean sessions that any pausing decision (`ask` + `ask_soft` + `block`) fires on — **not** just the `block` bucket. Reported split by confidence band. Measured via `scripts/composite-replay.ts --policy` on the STRONG tier.

```
decision   clean  drift
auto          7      1
ask_soft      3     10
ask           0      5
block         0      0

False-interception rate: 3/10 clean paused = 30.0%
  └─ high-confidence ask:  0/10 = 0.0%    ← high band: zero mis-stop
  └─ gray-zone ask_soft:   3/10 = 30.0%   ← all mis-stops are in the gray zone
Missed-interception rate: 1/16 real drifts auto-proceeded = 6.3%
```

**Key finding**: mis-stops are entirely confined to the gray zone; the high-confidence `ask` band has **0% false-interception**. This is what makes B2 safe: the first enforcement version can enable hard `ask` on the high band with zero UX cost, while the gray zone stays a soft nudge.

Tests: `tests/governance/policy.test.ts` (9 cases, threshold boundaries + reserved-block + config). Full suite 72/72 green.

### Stage B2 — PreToolUse enforcement (first version `ask` only) — DONE 2026-06-01

The runtime "hand" of track B: the layer that can actually pause the agent.

#### B2.1 Resolved: full composite, not a pre-execution subset (closes Open Q1)

Open Q1 worried that PreToolUse lacks `tool_result` and would force a stripped signal subset. Code audit killed that concern:

- v0.2's 6 detectors: 5 never touch `tool_result`; the only one that does (`retry_density`) uses **repetition-as-evidence** (same tool+target/message), not `outcome`.
- v0.1: only `hallucinated_claims` truly needs `tool_result` to verify a claim, and it carries little weight among the 8 semantic signals.

**Decision (frozen)**: reuse the FULL composite. At PreToolUse there is simply no `tool_result`, so `hallucinated_claims` has nothing to fire on and degrades to 0 — **no separate subset, no new thresholds to recalibrate.** Open Q1 downgrades from "build a new subsystem" to "one field defaults to absent".

#### B2.2 Interception scope (frozen, data-driven)

| Band | Decision | PreToolUse outcome | Pauses? |
|------|----------|--------------------|---------|
| `score ≥ 0.75` (high-confidence `ask`) | `ask` | `permissionDecision: "ask"` | **YES** |
| `0.45 – 0.75` (gray `ask_soft`) | `ask_soft` | `permissionDecision: "allow"` + soft advisory log | no |
| `< 0.45` (`auto`) | `auto` | `permissionDecision: "allow"` | no |
| `block` (reserved) | `block` | `permissionDecision: "deny"` | YES (never emitted in v1) |

Only the **high-confidence band hard-pauses** — B1 STRONG-tier replay measured **0% false-interception** there. The gray zone (~30% false-interception) only logs a nudge and proceeds. This is what makes B2 safe to ship: zero clean-session cost on day one.

#### B2.3 Escape valve

Enforcement is **OFF unless `DRIFT_ENFORCE=1`**. When off, every decision degrades to `allow` and nothing ever pauses — preserving the original hook's "never block the agent on Drift logic" / `exit 0` safety philosophy. A single env var rolls everything back to pure advisory.

#### B2.4 Implementation

- **`src/governance/enforcement.ts`** — pure `AuthorizationVerdict → permissionDecision` translation (`resolveEnforcement`), env escape valve (`enforcementConfigFromEnv`), and the exact Claude Code JSON serializer (`toHookOutput`). Isolated from I/O so it is fully unit-testable.
- **`scripts/claude-hook.ts`** — new `pre_tool_call` branch in `handlePreToolUse`: load the historical tool-event stream, append the tool about to run, run BOTH pipelines (v0.1 `SessionManager` + v0.2 `runAllDetectors`), `CompositeScorer.fuse` → `AuthorizationPolicy.decide` → `resolveEnforcement` → emit the decision JSON on stdout. `getHookEventType` now disambiguates Pre vs Post by `--event` flag or by the presence of a result field.

PreToolUse output contract (Claude Code):

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask" | "deny" | "allow",
    "permissionDecisionReason": "..." } }
```

#### B2.5 Claude Code wiring (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*",
        "hooks": [
          { "type": "command",
            "command": "DRIFT_ENFORCE=1 npx tsx /ABS/PATH/drift/scripts/claude-hook.ts --event PreToolUse" }
        ] }
    ]
  }
}
```

Omit `DRIFT_ENFORCE=1` (or set `=0`) to run advisory-only.

#### B2.6 Validation

- **`tests/governance/enforcement.test.ts`** (9 cases): high-confidence→ask pause, gray→allow+advisory, auto→silent allow, block→deny, escape valve all-allow, env parsing, JSON contract. Full suite **81/81 green**, `tsc --noEmit` clean.
- **Hook self-test** (temp dir, real composite pipeline): escape valve OFF→allow / ON→real score; with threshold lowered to 0.40, risk 0.41 correctly produced `permissionDecision: "ask"` + pause — proving the end-to-end events→composite→policy→enforcement→JSON path.
- **Known limit**: offline can only prove the *decision* is correct. Whether real Claude Code honors the `ask` JSON, pauses, and resumes can only be verified by **running one live session on the user's machine** — a runtime co-debug step, not an offline one.

#### B2.7 Status

Track B core loop — "important → user confirmation, unimportant → autonomous" — is now closed in code. Remaining: live runtime co-debug + (later) gray-zone tuning and `block` enablement once `ask` misjudgment feel is validated in production.

#### B2.8 Operational constraints + post-ship audit fixes

After wiring the hook into 4 client configs (`~/.claude`, `~/.codefuse`, `~/.codefuse/engine/cc`, `~/.codex`), a hidden-bug audit surfaced four issues — all fixed:

- **State scoped by `session_id`, not CWD** — initial design stored `.drift-state.json` / `.drift-events.jsonl` in CWD, which broke the actual usage pattern: Codex/Claude launch from `~`, CodeFuse from `~/skill`, and the user switches tasks via `/clear` (not by changing directory). CWD-scoping would collide all three clients into one file and conflate every task done from the same shell. **Fixed**: state now lives in `~/.drift/sessions/<session_id>/state.json` and `…/events.jsonl`. Each Claude Code session — including the one created by `/clear` — gets its own bucket. `$DRIFT_HOME` and `$DRIFT_SESSION_ID` override for advanced cases. Verified: sid-A on `~` and sid-B on `~/skill` stay isolated; sid-A continues correctly when resumed from `~/skill/drift`.
- **stderr visibility (P0)** — `~/.codefuse/hooks/drift-hook.sh` previously discarded stderr (`2>/dev/null`), making pause decisions and crashes invisible. Now appends to `~/.codefuse/logs/drift-hook.err.log`.
- **O(N²) hot path (P0)** — the first `handlePreToolUse` implementation rebuilt `SessionManager` + `setGoal` + `confirmGoal` + replayed every historical event per hook call, costing O(N²) over a session. Reworked to read the latest `drift_score` snapshot persisted by PostToolUse on the most recent `tool_call` event (O(N) read), then run only the stateless v0.2 detectors over the existing stream. Verified on 50 events: cold ~1.5s, warm ~400ms, well under the 10s hook timeout. v0.1 contribution is the score **as of the previous tool call** — the correct semantics for a *pre*-execution decision.
- **Missing `--event PostToolUse` argument** — `~/.codefuse/engine/cc/settings.json` had a Drift PostToolUse command that omitted the `--event` flag, leaving event-type inference to `getHookEventType` from payload shape. It happened to work but was fragile; the flag is now explicit.

---

## 4. Dependency Graph

```
A1 (strong corpus) ──┐
                     ├──> A3 (composite score) ──> B1 (policy + offline replay) ──> B2 (ask enforcement)
A2 (cognitive recall)┘
```

A1 and A2 are parallel. A3 requires both. B1 requires A3. B2 requires B1.

---

## 5. Open Questions

1. ~~Pre-execution signal subset: which of the 11 signals retain enrichment without tool_result?~~ **RESOLVED (B2.1)**: reuse full composite, `hallucinated_claims` degrades to 0 — no subset needed.
2. ~~Composite score shape: weighted-OR vs. layered max vs. learned weights?~~ **RESOLVED (A3)**: layered-max with a cognitive-hit white-list (3 zero-FP signals only); learned weights deferred until labeled data exists.
3. ~~ask threshold: what false-interception rate is acceptable for shipping B2?~~ **RESOLVED (B1.3 + B2.2)**: ship only the high-confidence band (≥0.75), which has 0% false-interception on the STRONG tier; gray zone stays advisory.
4. **OPEN** — Live runtime behavior: does Claude Code honor the `ask` JSON and resume cleanly after the user confirms? Offline cannot answer this; needs one live co-debug session.
5. **OPEN** — Gray-zone treatment: keep `ask_soft` as advisory-only, or graduate part of it to hard `ask` once production data shrinks its false-interception rate?
6. **OPEN** — When to enable `block`: what evidence threshold justifies hard `deny` over `ask`?
7. **OPEN** — Hook cold-start cost: each PreToolUse spawns `npx tsx`/`ts-node` (~1.2s cold, ~400ms warm). Monitor production timeout-hit rate; if non-negligible, switch to a precompiled `dist/` or a long-lived daemon process.
4. action-class taxonomy: how to define "authorization-class action" (scope-expanding writes, irreversible ops, goal mutation) vs. routine reads?
