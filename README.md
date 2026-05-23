# Drift

**Runtime observability for autonomous agents.**

Drift detects when an agent stops converging on your goal — whether it's expanding scope, forgetting the task, or stuck in a recursive loop.

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

**Current benchmark (20 well-defined fixtures):**

```
Precision: 0.750
Recall:    0.818
F1:        0.783
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
      "details": ["preview/pages.js (×6)", "mini-runtime.js (×5)"]
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
  "target": "preview/mini-runtime.js",
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
- `fixtures-valid/` — 20 well-defined fixtures (strong goals, clear annotations)
- `quarantine/weak/` — 3 fixtures with ambiguous goals
- `quarantine/non-evaluable/` — 39 fixtures with broken/missing goals

**Label schema:**

```json
{
  "drift": true,
  "drift_type": "scope_expansion",
  "drift_started_at": 1747051500000,
  "takeover_required": true,
  "annotated_by": "human",
  "groundtruth_quality": "strong"
}
```

**Contributing fixtures:** See `scripts/contribute.ts`. Real sessions only — synthetic traces not accepted.

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
├── fixtures-valid/ 20 well-defined labeled sessions
├── quarantine/     42 fixtures pending review
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