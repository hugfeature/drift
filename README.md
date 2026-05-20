# Drift

**Git Blame for Autonomous Agents.**

Drift detects when an agent stops working toward your goal and starts working toward its own.

```
Goal: "fix README typo"

T+1m   Read README.md              0.10  ✓ aligned
T+2m   Fix typo in README          0.26  ✓ aligned
T+5m   Read .eslintrc              0.42  ✓ aligned
T+8m   Upgrade eslint to v9        0.56  ⚡ drifting

⚠️  Human Takeover Recommended
   - Tool usage entropy critically high for 3+ consecutive evaluations
   → Verify agent has not lost focus

T+18m  Fix lint errors in auth.ts  0.79  ✗ lost
T+26m  Fix broken tests            0.65  ⚡ drifting
```

The agent was asked to fix a typo. 26 minutes later it's fixing broken tests caused by an eslint major version upgrade it introduced on its own.

Drift catches this at T+8m.

---

## The Problem

Every autonomous agent has this failure mode:

- User: "fix README typo"
- Agent fixes typo, notices lint warning
- Agent upgrades eslint
- Build breaks
- Agent fixes build errors
- Tests break
- Agent fixes tests
- 45 minutes later: three files changed, original task buried

This is **Goal Drift** — not a crash, not a loop, not a hallucination. The agent is working hard. Just not on what you asked.

Current tools catch runtime failures. None of them track whether the agent is still doing what you asked.

---

## Core Concept

```
Drift = Goal Alignment Failure
```

A runtime failure is not always drift.

| Runtime Behavior       | Drift? |
|------------------------|--------|
| tool retry             | not necessarily |
| token explosion        | not necessarily |
| failed tests           | not necessarily |
| unrelated exploration  | likely |
| forgotten original task | yes |
| unauthorized scope expansion | yes |

---

## Quick Start

```bash
git clone https://github.com/hugfeature/drift
cd drift
npm install
npm run demo
```

To run the eval benchmark:

```bash
npm run eval
```

```
Corpus:    62 fixtures (33 drift, 29 no-drift)
Precision: 0.545
Recall:    0.909
F1:        0.682
```

**Per-type recall:**

| Drift Type | Recall |
|------------|--------|
| scope_expansion | 100% |
| cleanup_spiral | 100% |
| unauthorized_mutation | 100% |
| rabbit_hole | 93% |
| interrupted_workflow | 50% |
| goal_forgotten | 50% |

---

## How It Works

```
Human Goal
    ↓
Session Manager
    ↓
Event Stream (tool_call, subgoal_created, ...)
    ↓
┌─── Drift Scorer  ←── 8 signals
├─── ClaimChecker  ←── hallucination detection
├─── SafetyScanner ←── dangerous operation detection
│
├─── Narrative Engine  ←── "T+18m goal forgotten"
├─── Takeover Engine   ←── "human intervention recommended"
└─── LangSmith Export  ←── trace observability
```

**Eight scoring signals:**

| Signal | What it measures |
|--------|-----------------|
| Semantic divergence | Embedding distance: current actions vs original goal |
| Inactive duration | Minutes since goal received an aligned action |
| Consecutive unrelated | Run of actions with no goal connection |
| Exploratory entropy | Shannon entropy of tool usage (scattered = high risk) |
| Subgoal depth | Nesting depth of agent-created subgoals |
| Unauthorized mutations | Goal changes without human approval |
| Autonomy momentum | Session duration × tool-to-user ratio |
| Hallucinated claims | Count of unverified tool_response claims |

**Goal Lifecycle:**

```
Goal Created → Refined → Expanded → Forgotten → Replaced
```

Only humans may create, replace, or cancel goals. Agents may refine within scope. Unauthorized mutations are tracked as governance events.

---

## Integrations

| Agent | Status |
|-------|--------|
| Claude Code | ✅ Available — [setup guide](docs/integrations/claude-code.md) |
| CCLI | ✅ Available — same hook mechanism as Claude Code |
| Cursor | 🔜 Planned |
| OpenAI Agent SDK | 🔜 Planned |
| Cline | 🔜 Planned |

---

## Project Structure

```
src/
├── types/          Goal, Session, Event, DriftScore, Narrative, Eval
├── goal/           GoalStore — state machine for Goal Lifecycle
├── events/         EventIngestion — agent event pipeline
├── scoring/        DriftScorer — 8-signal weighted scoring
├── narrative/      NarrativeEngine — runtime story reconstruction
├── governance/     TakeoverEngine — human intervention layer (6 triggers)
├── verification/   ClaimChecker — hallucinated state detection
├── safety/         SafetyScanner — dangerous operation detection (25 rules)
├── exporters/      LangSmith trace exporter
├── session/        SessionManager — orchestrates all modules
├── embedding/      Pluggable embedding providers
└── adapters/       Claude Code, Cursor (planned)

eval/
├── fixtures/       62 labeled real agent sessions
├── metrics/        DeepEval-compatible metric bridge
├── reports/        Structured JSON eval reports
└── runner.ts       Benchmark: precision / recall / F1 / per-type breakdown

tests/
├── verification/   ClaimChecker unit tests (11 tests)
└── safety/         SafetyScanner unit tests (20 tests)

examples/
└── readme-typo-drift.ts   End-to-end demo
```

---

## Eval Benchmark

Drift ships with a labeled fixture benchmark.

Each fixture is a real agent session with human annotations:

```json
{
  "drift": true,
  "drift_type": "scope_expansion",
  "drift_started_at": 1747051500000,
  "goal_forgotten_at": 1747051740000,
  "takeover_required": true,
  "annotated_by": "human"
}
```

Run it: `npm run eval`

### Contributing Fixtures

We need **real drift sessions**. The scorer can only improve with diverse, human-annotated data.

**What we're looking for:**

| Type | Description | Priority |
|------|-------------|----------|
| 🔴 Drift (positive) | Agent started doing unauthorized work | **Critical** — we have very few |
| 🟢 No-drift (negative) | Agent stayed aligned throughout | Useful for false-positive tuning |
| ⚡ Edge cases | Valid refinement that *looks* like drift | Helps calibrate thresholds |

**Drift types we track:**

| Type | Example |
|------|---------|
| `scope_expansion` | "Fix typo" → agent upgrades eslint |
| `goal_forgotten` | Agent stops working on goal, starts new task |
| `unauthorized_mutation` | Agent changes config/deps without asking |
| `rabbit_hole` | Agent debugs unrelated issue for 20+ minutes |
| `cleanup_spiral` | Agent starts "cleaning up" unprompted |

**How to contribute (3 commands):**

```bash
# 1. Anonymize your raw session (removes paths, code, keys)
npx ts-node scripts/anonymize-session.ts ~/.drift/sessions/my-session.json

# 2. Package as fixture with annotation template
npx ts-node scripts/contribute.ts my-session_anonymized.json --drift

# 3. Fill in the annotation, then PR
# Edit eval/fixtures/case_NNN.json — complete the annotator_notes
git add eval/fixtures/case_NNN.json && git commit -m "Add fixture: scope_expansion drift"
```

**Anonymization guarantees:**
- All absolute paths stripped (keeps last 2 segments only)
- Code content / stdout / tool_input redacted
- API keys, emails, IPs removed
- Timestamps normalized to T=0
- No way to identify contributor or project

**Real sessions only** — synthetic traces not accepted.

---

## Three Runtime Failure Modes

Drift detects three categories of autonomous agent failure:

| Mode | Description | Status |
|------|-------------|--------|
| **Goal Drift** | Agent stops pursuing original goal | ✅ Implemented (8 signals) |
| **Hallucinated State** | Agent claims actions succeeded but they didn't | ✅ Implemented (ClaimChecker) |
| **Safety Violation** | Agent performs dangerous operations | ✅ Implemented (25 rules) |

---

## Status

Core pipeline complete. All three failure modes implemented.

**What's working:**
- 8-signal drift scorer (semantic divergence + autonomy momentum + hallucination + 5 others)
- Hallucinated State detection (file existence + mtime, command exit code + output contradiction)
- Safety scanner (25 built-in rules across 6 categories)
- LangSmith trace integration (auto-export every score event)
- Goal Lifecycle state machine with governance
- Runtime narrative generation
- Human takeover recommendations (6 trigger types)
- Claude Code / CCLI adapter with auto-goal extraction
- Eval benchmark: 62 fixtures, per-type breakdown, JSON reports
- DeepEval-compatible metric bridge
- Session anonymization + contribution pipeline

**What's next:**
- Cursor / OpenAI Agent SDK adapters
- Real embedding model integration (nomic-embed / text-embedding-3-small)
- More eval fixtures — especially `interrupted_workflow` and `conflicting_context`
- DeepEval full Python integration

---

## Definition

> Drift is not a crash. It's the agent doing the wrong thing well.

---

MIT License