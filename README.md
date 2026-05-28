# Drift

**Runtime observability for autonomous agents.**

Drift detects when an agent stops converging on your goal — whether it's expanding scope, forgetting the task, or stuck in a recursive loop.

> ⚡ **The 45-minute typo incident** — I asked an agent to fix a README typo. 45 minutes later it had restructured the entire project. All tests passed. Lint was clean. The commit message was beautiful. But the agent was no longer working on what I asked.
>
> Output-layer eval tools (RAGAS, DeepEval) can't catch this. So I built Drift.
>
> **Current benchmark: Precision 0.773 · Recall 0.895 · F1 0.829** on 36 strong fixtures. Up from 0.545 → 0.773 in one week through scoring upgrades and fixture expansion — methodology details below.

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
| Drift taxonomy (6 types) | ❌ | ✅ |
| Works without LLM in scoring path | ❌ | ✅ pure signals |

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

**Eval methodology breakdown** is documented in the "Eval Methodology" section below. Reproduce the 0.773/0.895/0.829 benchmark with `npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid`.

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

**Current benchmark (36 strong fixtures):**

```
Precision: 0.773
Recall:    0.895
F1:        0.829
```

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
- `fixtures-valid/` — 36 strong fixtures (clear goals, human annotations)
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
├── fixtures-valid/ 36 strong labeled sessions
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