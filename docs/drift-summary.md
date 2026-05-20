# Drift Summary

Runtime Drift Detection and Failure Observability for Autonomous Agents.

The key problem: why does an agent gradually diverge from the original objective during long-running execution?

## Three Runtime Failure Modes

### 1. Goal Drift ✅ Implemented

Example:
- original task: fix a timeout bug
- later behavior: upgrade dependencies, refactor logging, rewrite CI

The original objective disappears and local optimization replaces global intent.

**Implementation:** 8-signal weighted scorer (semantic divergence, inactive duration, consecutive unrelated, exploratory entropy, subgoal depth, unauthorized mutations, autonomy momentum, hallucinated claims). Detects scope_expansion, goal_forgotten, unauthorized_replacement, depth_escalation, orphan_subgoal, interrupted_workflow, conflicting_context.

### 2. Hallucinated Runtime State ✅ Implemented

Examples:
- tests reported as passed even though they never executed
- file update reported successful even though the write failed
- command claimed exit_code=0 but output contains ERROR

**Implementation:** ClaimChecker extracts claims from tool_response events, routes to verification strategies (FileWriteStrategy: existence + mtime check; CommandExitStrategy: exit code + output contradiction detection). Produces ClaimVerdict with confidence scores. Hallucination count feeds into DriftScorer as a signal.

### 3. Distributed Hallucination Propagation 🔜 Not Yet Implemented

One agent creates invalid state and other agents accept it as true. The entire multi-agent system operates inside a fictional runtime reality.

This resembles distributed consensus failure. Deferred until multi-agent session support is added.

## Safety Module ✅ Implemented

Beyond drift detection, Drift also guards against dangerous agent operations:

- **6 categories:** destructive_command, sensitive_file_access, data_exfiltration, privilege_escalation, network_exposure, secrets_in_output
- **25 built-in rules** with configurable risk thresholds
- Triggers human takeover on high/critical violations

## Architecture

```
EventIngestion → GoalStore → DriftScorer (8 signals)
                                ↑
                          ClaimChecker (hallucination)
                          SafetyScanner (safety)
                                ↓
                     NarrativeEngine → TakeoverEngine (6 triggers)
                                ↓
                       LangSmithExporter (trace observability)
```

## Eval Benchmark

- **62 labeled fixtures** from real agent sessions
- **7 drift types** tracked
- Per-type precision/recall/F1 breakdown
- DeepEval-compatible JSON metric bridge
- Structured reports in `eval/reports/`

Current results: Precision 0.545, Recall 0.909, F1 0.682

## Positioning

- Runtime Drift Detection for Autonomous Agents
- Runtime Failure Analysis for Agent Systems
- Runtime Observability for Autonomous Execution

## Scope

Focus on:
- runtime timeline reconstruction
- drift detection (8 signals)
- hallucination verification (claim checking)
- safety guard (dangerous operation detection)
- human takeover signals (6 trigger types)
- runtime failure corpus collection
- LangSmith trace integration

Avoid early expansion into:
- universal truth engines
- generalized verification infrastructure
- complete trust graph systems
- multi-agent consensus (deferred)

## Final Insight

The major challenge of autonomous agents is shifting from model intelligence toward reliability during long-running autonomous execution.

Drift ultimately studies autonomous runtime failure rather than prompt engineering or chatbot quality.
