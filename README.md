# drift

> Runtime governance for autonomous coding agents.

Drift helps developers understand when agents stop pursuing the original goal.

---

# Core Definition

```txt
Drift = Goal Alignment Failure
```

Drift is not:
- latency
- token usage
- observability health
- infrastructure monitoring

Drift happens when an agent gradually diverges from the original human intent.

Examples:
- fixing unrelated files after the original task completed
- expanding scope without approval
- entering exploratory loops
- replacing the user goal with self-generated work

This project focuses on intent continuity.

Not generic observability.

---

# Why Drift Exists

Coding agents are becoming increasingly autonomous.

They:
- rewrite implementation paths
- retry failed actions
- generate new subgoals
- search documentation endlessly
- mutate execution plans over time

Humans eventually lose visibility into:
- whether the original task is still active
- whether exploration is still legitimate
- when intervention is required
- whether the agent is still aligned with user intent

Operational systems require runtime governance.

---

# Core Concepts

## Goal Lifecycle

```txt
Goal Created
    ↓
Goal Refined
    ↓
Goal Expanded
    ↓
Goal Forgotten
    ↓
Goal Replaced
```

Drift tracks how goals evolve during long-running execution.

---

## Goal Authority Model

```txt
Human Goal
    ↓
System Goal
    ↓
Agent Subgoal
```

Only humans can:
- create goals
- replace goals
- cancel goals

Agents may generate subgoals.

Agents must not silently replace the original intent.

---

## Runtime Narrative

Drift converts noisy execution traces into understandable runtime stories.

Example:

```txt
14:32 Agent started drifting after dependency upgrade.

Reason:
- original task became inactive
- exploratory actions increased
- unrelated files were modified
```

The objective is not just replay.

The objective is explainability.

---

## Human Takeover

Autonomy should not mean invisibility.

Drift helps determine:
- when agents are still aligned
- when exploration becomes risky
- when humans should intervene

Example:

```txt
Drift Score: 0.82

Recommendation:
Human intervention suggested.
```

---

# Architecture

```txt
Agent Runtime
      ↓
Collector Layer
      ↓
Normalized Events
      ↓
Goal Tracker
      ↓
Divergence Scoring
      ↓
Runtime Narrative Engine
      ↓
Human Takeover Recommendation
```

---

# Project Structure

```txt
drift/
 ├── goal/
 │    ├── extractor/
 │    ├── tracker/
 │    └── continuity/
 │
 ├── events/
 │    ├── parser/
 │    └── schema/
 │
 ├── scoring/
 │    ├── divergence/
 │    ├── entropy/
 │    └── takeover/
 │
 ├── narrative/
 │    └── generator/
 │
 ├── replay/
 │
 └── eval/
```

---

# Event Model

```json
{
  "id": "evt_001",
  "timestamp": 1747051200,
  "agent": "claude-code",
  "goal_id": "goal_001",
  "type": "tool_call",
  "tool": "edit_file",
  "target": "src/auth.ts",
  "semantic_intent": "upgrade dependency",
  "drift_score": 0.71,
  "message": "Agent started modifying unrelated build configuration"
}
```

---

# MVP

Initial scope:

- goal tracking
- runtime event normalization
- divergence scoring
- runtime narrative generation
- replay timeline
- human takeover recommendation

Not building:
- another agent framework
- another chat UI
- full observability platform

---

# Roadmap

## Phase 1
- Goal Schema v0
- runtime event schema
- local embedding divergence scoring
- runtime narrative prototype
- replay timeline

## Phase 2
- drift benchmark dataset
- takeover recommendation engine
- multi-session evaluation
- Claude Code adapter
- Cursor adapter

## Phase 3
- goal graph modeling
- runtime governance policies
- OpenTelemetry integration
- multi-agent coordination
- drift benchmark publication

---

# Vision

AI agents are evolving from assistants into operational systems.

Operational systems require:
- observability
- accountability
- governance
- intent continuity

Drift aims to become the runtime governance layer for autonomous software agents.

---

# Status

Early research prototype.

Current focus:
- goal continuity tracking
- runtime drift detection
- runtime narrative generation
- human takeover boundaries

Contributions and discussions are welcome.
