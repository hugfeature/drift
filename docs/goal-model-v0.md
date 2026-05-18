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

Important:

Normalization itself is a semantic inference problem.

v0 strategy:

```txt
LLM normalization
        +
Human confirmation
```

The runtime proposes observable operational targets.

Humans confirm whether the normalized goal matches the intended task.

This confirmation event becomes runtime data.

Example:

```json
{
  "event": "goal_confirmed",
  "source": "human",
  "normalized_goal": {
    "observable_targets": [
      "lint",
      "format",
      "unused_files"
    ]
  }
}
```

The runtime does not attempt to discover semantic truth.

It attempts to create operationally observable intent.

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

Agents may refine goals within the original scope.

Allowed:

```txt
Fix login bug
→
Fix OAuth token refresh issue
```

Not allowed:

```txt
Fix login bug
→
Refactor authentication architecture
```

Constraint:

Agent refinement must not:
- replace observable targets
- shrink original intent
- introduce unrelated execution domains

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
- exploratory continuity

Single unrelated actions are insufficient.

v0 heuristic:

```txt
5 consecutive unrelated actions
+
10 minute inactive goal window
+
increasing exploratory entropy
```

These thresholds are intentionally operational rather than theoretically optimal.

v0 prioritizes:
- observability
- reproducibility
- benchmarkability

Thresholds are expected to evolve through runtime evaluation.

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

# Subgoal Depth

Agent subgoals may recursively generate new subgoals.

Example:

```txt
Fix login bug
  → Fix OAuth refresh
    → Refactor token store
      → Upgrade jwt library
        → Fix breaking changes in tests
```

Deep subgoal nesting increases drift risk.

Reason:
- original intent becomes inactive
- local optimization dominates execution
- unrelated maintenance work accumulates

v0 runtime rule:

```txt
subgoal_depth <= 3
```

Subgoal depth beyond 3 triggers:
- elevated drift risk
- runtime warning
- takeover recommendation consideration

---

# Goal Mutation Rules

| Actor | Create | Refine | Expand | Replace |
|---|---|---|---|---|
| Human | yes | yes | yes | yes |
| System | no | yes | suggest only | no |
| Agent | no | yes, within scope | suggest only | no |

---

# Drift Detection Principles

Drift scoring should combine:

- semantic divergence
- action continuity
- exploratory entropy
- inactive goal duration
- unauthorized scope expansion
- subgoal depth escalation

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
- subgoal depth exceeded safe threshold

Recommendation:
Human intervention suggested.
```

The runtime objective is not merely detection.

The objective is actionable operational visibility.
