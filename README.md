# Drift

**Runtime observability for autonomous agents.**

Drift detects when an agent stops converging on your goal — whether it's expanding scope, forgetting the task, or stuck in a recursive loop.

> ⚡ **The 45-minute typo incident** — I asked an agent to fix a README typo. 45 minutes later it had restructured the entire project. All tests passed. Lint was clean. The commit message was beautiful. But the agent was no longer working on what I asked.
>
> Output-layer eval tools (RAGAS, DeepEval) can't catch this. So I built Drift.
>
> **Current benchmark: F1 0.80 · Recall 0.89 · Precision 0.73** on 41 strong fixtures. Threshold `drifting ≥ 0.45` is tuned for high recall — **in runtime governance, a missed drift costs more than a false alarm.** Evolution: F1 0.545 (5/22) → peak F1 0.829 / P 0.773 (5/28, after scoring upgrades + fixture expansion) → current 0.80 (recall-tuned after adding 5 cognitive-layer cases for v0.2 risk-layer eval). Methodology below.
>
> **v0.2 (cognitive layer, experimental):** 3 new risk signals — `completion_coverage` · `assertion_without_verification` · `obligation_closure` — target a failure class where the agent executes flawlessly but does the wrong/incomplete thing. RFC coverage matrix: 6/6 cognitive-failure cases (063–068). Measured enrichment lands in RFC Appendix C (pending replay). See [`docs/rfc-risk-layer-v0.1.md`](docs/rfc-risk-layer-v0.1.md).

```
Goal: "fix README typo"

T+1m   Read README.md              aligned    ✓
T+2m   Fix typo in README          aligned    ✓
T+5m   Read .eslintrc              aligned    ✓
T+8m   Upgrade eslint to v9        drifting   ⚡

⚠️  Drift Detected — scope_expansion
  Evidence:
    • Actions diverge from goal by 62%
    • Agent running autonomously: 8/8 events are tool calls
    • Unauthorized scope change: eslint upgrade not in goal
  Severity: high
  Recommend: Review recent actions for unauthorized scope changes.
```

---

## Why Drift Exists

Every autonomous agent has this failure mode:

1. User: "fix README typo"
2. Agent fixes typo, notices lint warning
3. Agent upgrades eslint → build breaks → fixes build → tests break → fixes tests
4. 45 minutes later: original task buried under scope expansion

This is **Goal Drift** — not a crash, not a hallucination. The agent is working hard. Just not on what you asked.

Drift is the only system that provides **interpretable runtime diagnostics** for this failure mode — not just a score, but an evidence chain explaining *what happened*, *when it started*, and *what to do about it*.

---

## What Makes Drift Different

| Capability | Pure Eval Tools | Drift |
|------------|----------------|-------|
| Detects drift after session ends | ✅ | ✅ |
| Detects drift in real-time | ❌ | ✅ |
| Explains *why* drift happened | ❌ | ✅ evidence chains |
| Detects behavioral loops (rabbit hole) | ❌ | ✅ independent detector |
| Temporal trajectory analysis | ❌ | ✅ timeline export |
| Drift taxonomy (13 types) | ❌ | ✅ |
| Works without LLM in scoring path | ❌ | ✅ pure signals |

---
## Where Drift Sits in the Safety Landscape

In March 2026, OpenAI published [how it monitors its internal coding agents for misalignment](https://openai.com/index/how-we-monitor-internal-coding-agents-misalignment/) — a monitor powered by their strongest reasoning model reviews each agent session (chain-of-thought, actions, tool calls) and flags behavior that diverges from user intent or circumvents internal controls. Their roadmap points toward *synchronous* interception: evaluating an action **before** it executes.

That work validates the core premise Drift is built on — **runtime behavior monitoring is becoming a first-class safety layer for autonomous coding agents, not an afterthought.** But the two approaches sit at opposite ends of a cost/portability spectrum:

| | OpenAI internal monitor | Drift |
|---|---|---|
| Detection engine | Strongest reasoning LLM reviews CoT + actions | 11 structured signals, **no LLM in scoring path** |
| Latency / cost | Asynchronous, heavyweight | Synchronous-capable, cheap, reproducible |
| Deployment | Internal, model-provider-specific | Self-hostable on any agent's trace stream |
| Output | Flagged for human review | Evidence chain (`signal → observation → details`) |
| Reproducibility | Depends on monitor model version | Deterministic — same trace, same score |

Drift is the lightweight, explainable, self-deployable counterpart to that premise: the same idea — *catch the agent doing the wrong thing well, at runtime* — without a frontier model in the loop, so any team can run it on its own agents.

### Why behavior-layer, not chain-of-thought?

A fair challenge. OpenAI's [CoT-monitorability research](https://openai.com/index/evaluating-chain-of-thought-monitorability/) (Dec 2025) found that **monitoring an agent's chain-of-thought is substantially more effective than monitoring its actions and outputs alone.** If reading the reasoning works better, why does Drift deliberately keep *no LLM in the scoring path* and score only behavior?

Because CoT monitoring is the deeper layer, but it is also the **expensive, fragile, and not-always-available** one — and Drift is built to be the layer underneath it:

- **It's expensive.** Effective CoT monitoring needs a strong reasoning model in the loop reviewing every session. That same paper quantifies a "monitorability cost." Drift's behavior signals are deterministic and free to compute — cheap enough to run on *every* session, synchronously, as an always-on floor.
- **It's fragile.** The paper's own central worry is that CoT monitorability may **degrade** under RL scaling, distillation, or training-process drift — the faithful-reasoning signal is not guaranteed to survive. Behavior is not a private workspace the model can learn to keep clean: what the agent *did* is on the record regardless of what it chose to narrate.
- **It's not always there.** Many agents and closed models expose no faithful CoT at all. Drift only needs a structured trace of actions, so it runs where CoT monitoring simply can't.

So this isn't behavior-*instead-of*-CoT. It's **defense-in-depth**, which is exactly how that paper frames CoT monitoring itself — one layer among several, each with blind spots. Drift is the cheap, reproducible, always-on behavior floor; CoT monitoring (and mechanistic interpretability above it) are the deeper, costlier layers that sit on top. A missed drift at the behavior floor is caught upstairs; a CoT signal that silently degrades still leaves the behavior floor standing.
---

## For Evaluators / Eval Engineers

If you build or run Agent eval pipelines, drift complements rather than replaces what you have:

**Drift is not for you if** — your agents are stateless, single-turn QA systems. RAGAS / DeepEval already cover this.

**Drift is for you if** — your agents run multi-step autonomous sessions and any of these happen:
- Tests pass but the agent did something unexpected
- You can't tell from logs whether scope expanded mid-session
- A model upgrade silently changed agent behavior patterns
- Multi-agent systems where one agent's drift cascades to others

**What you get out of the box:**
- **6 drift types** with distinct temporal signatures (scope_expansion / rabbit_hole / goal_forgotten / interrupted_workflow / unauthorized_replacement / depth_escalation)
- **11 scoring signals** (8 semantic + 3 behavioral), all computed from structured trace data — **no LLM in the scoring path** (reproducible, explainable, cheap)
- **Tri-state label schema** — `worth_inspection: true` carves out exploratory-but-valid sessions so they don't pollute your Precision/Recall numbers
- **Evidence chains** — every detection comes with `signal → observation → details`, not just a score
- **Real-session-only fixture policy** — synthetic traces rejected; fixtures grow via auto-collection hook + human review

**Eval methodology breakdown** is documented in the "Eval Methodology" section below. Reproduce the current benchmark (F1 0.80, recall-favoring) with `npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid`.

---

## Quick Start

```bash
git clone https://github.com/hugfeature/drift
cd drift
npm install

# Run eval benchmark
npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid

# Generate temporal timelines
npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid --timeline
```

### Replay your own trace

Point Drift at a real Claude Code transcript and get a drift report in seconds —
no need to run the bundled fixtures.

```bash
# 1. Find your real sessions (sorted by tool-call count)
npx ts-node scripts/import-claude-transcript.ts --scan \
  ~/<agent—dir>/projects/<your-project-slug>/

# 2. Convert one session into a Drift fixture
mkdir -p /tmp/my-trace
npx ts-node scripts/import-claude-transcript.ts \
  ~/<agent—dir>/projects/<slug>/<session-id>.jsonl \
  /tmp/my-trace/session.json

# 3. Score it
npx ts-node eval/runner.ts --fixture-dir=/tmp/my-trace
```

**Current benchmark (41 strong fixtures):**

```
Precision: 0.727
Recall:    0.889
F1:        0.800
```

> Threshold `drifting ≥ 0.45` is tuned for high recall — in runtime governance,
> missing a real drift is worse than flagging a benign one. An earlier
> precision-favoring config peaked at F1 0.829 / P 0.773 / R 0.895 (5/28, before
> 5 cognitive-layer cases were added for v0.2 risk-layer evaluation).

---

## Architecture

```
Agent Event Stream
    ↓
┌─────────────────────────────────────────────────┐
│  Session Manager                                 │
│                                                  │
│  ┌── Drift Scorer ──────────────────────────┐   │
│  │   8 semantic/structural signals           │   │
│  │   + Goal Clarity Gate                     │   │
│  │   + Automation Detection                  │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌── Rabbit Hole Detector ──────────────────┐   │
│  │   Behavioral pathology (independent)      │   │
│  │   target_repetition · novelty_decay       │   │
│  │   progress_stagnation                     │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌── Explanation Builder ───────────────────┐   │
│  │   Structured diagnostic traces            │   │
│  │   evidence · severity · recommendation    │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌── Timeline Builder ──────────────────────┐   │
│  │   Per-event temporal metrics              │   │
│  │   goal_alignment · novelty · depth        │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌── Narrative Engine ──────────────────────┐   │
│  │   Runtime story reconstruction            │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌── Takeover Engine ───────────────────────┐   │
│  │   Human intervention recommendations     │   │
│  └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Drift Taxonomy

| Type | What it looks like | Detection method |
|------|-------------------|-----------------|
| `scope_expansion` | "Fix typo" → agent upgrades eslint | Semantic divergence spike |
| `rabbit_hole` | Agent reads/runs same files 100+ times, never converges | Behavioral detector (target repetition + novelty decay) |
| `goal_forgotten` | Agent starts unrelated work, original goal inactive | Consecutive unrelated + inactive duration |
| `interrupted_workflow` | Agent resumes after interruption but diverges | Post-interrupt semantic shift |
| `unauthorized_replacement` | Agent replaces goal without human authority | Governance mutation tracking |
| `depth_escalation` | Subgoal nesting exceeds safe threshold | Subgoal depth signal |
| `constraint_circumvention` | Constraint still in force; agent evades it (base64-obfuscated commands, force-push via alias, rerouting a blocked command) | SafetyScanner hit + "denied → adjust → retry" pattern |

> The full failure taxonomy (13 drift types + 4 reasoning-failure types) lives in [`docs/drift-type-taxonomy.md`](docs/drift-type-taxonomy.md). `constraint_circumvention` maps to the most common misalignment shape OpenAI [reported](https://openai.com/index/how-we-monitor-internal-coding-agents-misalignment/) across tens of millions of internal coding-agent runs.

---

## Scoring Signals

**Semantic layer (8 signals):**

| Signal | What it measures |
|--------|-----------------|
| `semantic_divergence` | Embedding distance: execution payload vs goal |
| `autonomy_momentum` | Tool-to-user event ratio (agent running unattended) |
| `consecutive_unrelated` | Run of actions with no goal connection |
| `inactive_duration` | Minutes since goal received aligned action |
| `exploratory_entropy` | Shannon entropy of tool usage |
| `subgoal_depth` | Nesting depth of agent subgoals |
| `unauthorized_mutations` | Goal changes without human approval |
| `hallucinated_claims` | Unverified tool_response claims |

**Behavioral layer (independent rabbit hole detection):**

| Signal | What it measures |
|--------|-----------------|
| `target_repetition` | Fraction of actions hitting already-visited files |
| `novelty_rate` | Rate of new targets appearing (decays in rabbit hole) |
| `progress_stagnation` | Exploration-to-edit ratio (high = stuck) |

**Composite risk score (one number for downstream consumers):**

The execution layer (continuous score) and the cognitive layer (zero-FP discrete signals) are fused via **layered-max**: a cognitive-layer hit lifts the composite into the high-risk band so it is never diluted, otherwise the composite degrades to the trustworthy execution score. This yields a single explainable risk number — the input the authorization layer reads.

```
composite = max(execution_score, any_cognitive_hit ? 0.85 : 0)
```

On the strong tier this lifts recall (0.889 → 0.929) while holding precision (0.722 ≈ 0.727 baseline). Reproduce with `npx ts-node scripts/composite-replay.ts`. Design: [`docs/rfc-scoring-and-authorization-roadmap.md`](docs/rfc-scoring-and-authorization-roadmap.md) §A3.

---

## Explanation Traces

Every drift detection includes a structured diagnostic:

```json
{
  "classification": "rabbit_hole",
  "severity": "high",
  "summary": "Agent stuck in recursive loop — 75% of actions hit already-visited targets",
  "evidence": [
    {
      "signal": "target_repetition",
      "observation": "Repeated file operations: 75% hit same targets",
      "details": ["preview/pages-config.js (×6)", "preview-runtime.js (×5)"]
    },
    {
      "signal": "novelty_rate",
      "observation": "Novelty collapsed: only 0% of recent actions target new files"
    },
    {
      "signal": "progress_stagnation",
      "observation": "Progress stalled: exploration-to-edit ratio stagnant"
    }
  ],
  "first_observed_at": 68,
  "recommendation": "Interrupt agent and re-state the acceptance criteria."
}
```

---

## Timeline Export

Generate per-event temporal trajectories for visualization:

```bash
npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid --timeline
# Output: eval/timelines/*.timeline.json
```

Each timeline point contains:

```json
{
  "event_index": 120,
  "tool_name": "Read",
  "target": "preview/preview-runtime.js",
  "goal_alignment": 0.43,
  "cumulative_novelty": 0.37,
  "exploration_depth": 0.90,
  "progress_density": 0.10,
  "status": "drifting"
}
```

Temporal signatures distinguish drift types:
- **rabbit_hole**: novelty monotonically decreasing, exploration_depth sustained high
- **scope_expansion**: goal_alignment step-drops at specific events
- **goal_forgotten**: alignment flat-low after a transition point

---

## Eval Methodology

Drift uses a curated benchmark of real agent sessions with human annotations.

**Data quality tiers:**
- `fixtures-valid/` — 41 strong fixtures (clear goals, human annotations)
- `quarantine/` — fixtures with ambiguous goals or broken data

**Label schema (tri-state):**

```json
{
  "drift": true,
  "drift_type": "scope_expansion",
  "drift_started_at": 1747051500000,
  "worth_inspection": false,
  "takeover_required": true,
  "annotated_by": "human",
  "groundtruth_quality": "strong"
}
```

`worth_inspection: true` marks sessions that exhibit notable behavior (exploratory-but-valid, ambiguous boundary) — excluded from Precision/Recall but included in explainability evaluation.

**Auto-collection:** Fixtures grow automatically as you use Drift. The hook collects high-confidence sessions (score ≥ 0.7 or ≤ 0.15) as candidates. Review with:

```bash
npx ts-node scripts/review-candidates.ts              # list candidates
npx ts-node scripts/review-candidates.ts --approve-all  # approve high-confidence
```

**Manual contribution:** See `scripts/contribute.ts`. Real sessions only — synthetic traces not accepted.

---

## Project Structure

```
src/
├── types/          Goal, Session, Event, DriftScore, Eval types
├── goal/           GoalStore — state machine for Goal Lifecycle
├── scoring/        DriftScorer + RabbitHoleDetector + ExplanationBuilder
├── timeline/       TimelineBuilder — per-event temporal metrics
├── narrative/      NarrativeEngine — runtime story reconstruction
├── governance/     TakeoverEngine — human intervention layer
├── verification/   ClaimChecker — hallucinated state detection
├── safety/         SafetyScanner — dangerous operation detection
├── embedding/      Pluggable providers (Keyword, Ollama)
├── session/        SessionManager — orchestrates all modules
└── adapters/       Claude Code hook

eval/
├── fixtures-valid/ 41 strong labeled sessions
├── candidates/     Auto-collected sessions pending human review
├── quarantine/     Fixtures with broken/ambiguous data
├── timelines/      Generated temporal trajectories (gitignored)
├── reports/        Structured JSON eval reports
└── runner.ts       Benchmark runner (--timeline, --ollama flags)
```

---

## Integrations

| Agent | Status |
|-------|--------|
| Claude Code / CCLI | ✅ Available |
| Cursor | 🔜 Planned |
| OpenAI Agent SDK | 🔜 Planned |

---

## Definition

> Drift is not a crash. It's the agent doing the wrong thing well.

---

MIT License