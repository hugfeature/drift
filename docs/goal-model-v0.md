# Goal Model v0

## Purpose

Drift measures whether an autonomous agent is still aligned with the original human intent.

This document defines the foundational goal semantics used by the runtime.

---

# Core Principle

```txt
Drift = Goal Alignment Failure
```

A runtime failure is not always drift.

Examples:

| Runtime Behavior | Drift? |
|---|---|
| tool retry | not necessarily |
| token explosion | not necessarily |
| failed tests | not necessarily |
| unrelated exploration | likely |
| forgotten original task | yes |
| unauthorized scope expansion | yes |

Drift is specifically about intent continuity.

---

# Goal Authority Model

```txt
Human Goal
    ↓
System Goal
    ↓
Agent Subgoal
```

## Human Goal

Source of truth.

Only humans may:
- create goals
- replace goals
- cancel goals

Example:

```txt
Fix login bug.
```

---

## System Goal

Normalized operational representation.

Example:

Human input:

```txt
Clean up the project.
```

System normalization:

```json
{
  "observable_targets": [
    "lint",
    "format",
    "unused_files"
  ]
}
```

The runtime does not attempt to infer semantic truth.

It converts ambiguous intent into observable operational objectives.

---

## Agent Subgoal

Execution-level goals generated during runtime.

Example:

```txt
Upgrade eslint.
```

Subgoals are temporary.

Subgoals must not silently replace the human goal.

---

# Goal Lifecycle

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

---

# Goal Events

## Goal Created

Triggered when:
- a human starts a session
- a human provides a task
- a new execution objective is explicitly declared

Example:

```json
{
  "event": "goal_created",
  "source": "human",
  "goal": "fix login bug"
}
```

---

## Goal Refined

Goal semantics remain stable.

Operational details become more specific.

Example:

```txt
Fix login bug
→
Fix OAuth token refresh bug
```

---

## Goal Expanded

Additional scope is introduced while preserving the original intent.

Example:

```txt
Fix login bug
+
Add authentication logging
```

Expansion may be:
- human-approved
- system-suggested
- agent-proposed

Unapproved expansion increases drift risk.

---

## Goal Forgotten

The runtime no longer demonstrates active alignment with the original goal.

Detection requires:
- semantic divergence
- temporal persistence

Single unrelated actions are insufficient.

Potential heuristic:

```txt
N consecutive unrelated actions
+
inactive original goal window
+
increasing exploratory behavior
```

---

## Goal Replaced

The original goal becomes invalid.

Only humans may authorize replacement.

Example:

```txt
Original:
Fix README typo

Replacement:
Refactor CI pipeline
```

Example mutation event:

```json
{
  "event": "goal_mutation",
  "source": "human",
  "type": "replace",
  "old_goal": "fix README typo",
  "new_goal": "refactor CI pipeline"
}
```

---

# Goal Mutation Rules

| Actor | Create | Refine | Expand | Replace |
|---|---|---|---|---|
| Human | yes | yes | yes | yes |
| System | no | yes | suggest only | no |
| Agent | no | no | suggest only | no |

---

# Drift Detection Principles

Drift scoring should combine:

- semantic divergence
- action continuity
- exploratory entropy
- inactive goal duration
- unauthorized scope expansion

Drift must not rely solely on:
- token usage
- retries
- infrastructure failures

---

# Human Takeover Boundary

Drift eventually becomes a governance problem.

Example:

```txt
Drift Score: 0.87

Reason:
- original goal inactive
- unrelated subgoals increasing
- exploratory actions escalating

Recommendation:
Human intervention suggested.
```

The runtime objective is not merely detection.

The objective is actionable operational visibility.
