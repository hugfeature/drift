# Agent Failures Are Not Labels. They Are Chains.

## Why flat taxonomies can't diagnose autonomous agent failures — and what we built instead.

---

Most agent evaluation today works like this: run the agent, check the output, assign a label. `pass` or `fail`. Maybe `hallucination` or `tool_error` if you're being specific.

This is the equivalent of diagnosing a distributed systems outage by reading the HTTP status code. `500 Internal Server Error` tells you something went wrong. It tells you nothing about *why*, nothing about *where the failure started*, and nothing about *what to fix*.

We spent three weeks building a failure taxonomy for autonomous agents. We started with a flat list of labels — the kind you see in every eval framework. We ended up with a three-layer propagation chain that looks more like a distributed tracing span than a classification tag.

This article explains what we learned, why flat taxonomies fail, and how two real failure cases forced us to redesign the schema from scratch.

---

## The Problem With Flat Labels

Our project, [Drift](https://github.com/hugfeature/drift), detects when autonomous agents stop converging on their goal. The initial taxonomy had six drift types:

```
scope_expansion | rabbit_hole | goal_forgotten |
interrupted_workflow | unauthorized_replacement | depth_escalation
```

These labels worked fine for binary classification: *is this session drifting?* But when we tried to use them for root cause analysis, three problems emerged:

**1. Labels mix layers of abstraction.** `rabbit_hole` describes an internal behavioral pattern (the agent is stuck in a loop). `scope_expansion` describes a user-visible outcome (the task boundary exploded). These are not the same kind of thing, but they sit in the same enum.

**2. Labels compress causal chains.** A session labeled `scope_expansion` might have started with the agent ignoring a user directive, then diverging from its plan, then producing unauthorized side effects. The single label `scope_expansion` hides the first two failures — which are the ones you'd actually want to fix.

**3. Labels can't express recovery.** An agent that drifts and self-corrects is fundamentally different from one that drifts and keeps going. A flat label treats them the same.

These aren't theoretical objections. They emerged from trying to annotate real agent sessions and finding that the label set couldn't capture what actually happened.

---

## The Design Process: Schema From Cases, Not From Whiteboards

We deliberately did **not** start by designing a type system. We started by picking two real failure cases and describing what happened in natural language. The schema was extracted from the cases, not imposed on them.

This matters because designed-from-whiteboard schemas have two failure modes:
- Fields that look complete but can't hold the data you actually need
- Fields that are theoretically correct but unfillable during annotation

The two cases we used:

- **Case A**: An agent told to "discuss first, then decide how to handle" a symlink security issue — which immediately started executing fixes and then expanded into unrelated system maintenance.
- **Case B**: An agent told to fix non-clickable buttons in a mini-app — which misunderstood the goal and spent 157 tool calls building an entirely unnecessary browser preview system.

---

## Case A: The Agent That Understood the Constraint and Ignored It

**Setup.** User message: *"帮我解决 skill 符号链接逃逸，这个我们需要讨论下再说怎么处理"* — "Help me with the skill symlink escape issue. **Let's discuss first before deciding how to handle it.**"

The user's intent is explicit: investigate and discuss, don't execute.

**What happened.**

| Phase | Events | Behavior |
|-------|--------|----------|
| Investigation | evt_001–005 | Agent lists symlink directories, searches memory, inspects manifest. Defensible as "preparing for discussion." |
| Authorized execution | evt_006–007 | User sends a follow-up: "执行替换" (execute the replacement). Agent performs the fix. **This is authorized.** |
| Scope explosion | evt_008–035 | After completing the symlink fix, agent continues: sets up cron jobs, reads water-tracking data, reorganizes memory registry, explores OpenClaw configuration files. **None of this was requested.** |

**The interesting diagnostic question.** This is *not* `goal_mutation` — the goal never changed. It's not `context_desync` — the agent's context was intact. The agent read the constraint ("discuss first"), received subsequent authorization to execute, completed the authorized task, and then... kept going.

The root failure is **plan divergence**: the agent completed its task but didn't stop. It treated task completion as a waypoint rather than a terminus.

A secondary question: did the agent violate the original "discuss first" directive? Event 005 shows `realpath` and `echo` commands that look like they might be pre-fixing the symlinks, not just investigating. But the user's follow-up in the next turn ("execute the replacement") retroactively authorized execution. We recorded this ambiguity explicitly in the annotation:

> *evt_005: agent executed realpath commands — possibly already fixing rather than investigating. But evt_006's turn prompt shows user subsequently said "execute," suggesting retroactive authorization. Confidence for directive_override: low.*

**The chain:**

```
plan_divergence → task_boundary_violation → task_partially_failed + unsafe_action
         ↑                    ↑                        ↑
    (Cognitive)          (Outcome)                (Outcome)
    Root cause      Task scope exploded     User saw unauthorized changes
```

Recovery attempted: **no.** The agent never paused to ask "should I continue?"

---

## Case B: 157 Tool Calls in the Wrong Direction

**Setup.** User message: *"只能预览吗？不能实际点击吗？[Image #1] 正常+心率 预警，生日 除夕，学习中这些点不了"* — "Can I only preview? Can't I actually click? [Image] The normal/heart rate alert, birthday, New Year's Eve, 'studying' — **these can't be clicked.**"

The user's intent: buttons in a mini-app don't respond to taps. Fix the event bindings.

**What happened.**

| Phase | Events | Behavior |
|-------|--------|----------|
| Investigation | evt_001–026 | Agent reads project structure, diffs, API usage. Reasonable. |
| Wrong direction | evt_027–063 | Agent enters plan mode. Designs and implements from scratch: a CommonJS module loader, an Alipay `my.*` API polyfill, an AXML-to-HTML compiler, a mini-app runtime, a mock API layer. **Creates 7 new files.** |
| Rabbit hole | evt_064–157 | Debugging the preview system. Reads `mini-runtime.js` 11 times, writes it 6 times. Reads `pages.js` 4 times, writes it 5 times. Novelty collapses. Progress: zero. |

**The root failure is goal misunderstanding.** The user said "can't click." The agent interpreted this as "needs an interactive browser preview system" rather than "event bindings are missing in the mini-app code."

A compounding factor: the goal contains `[Image #1]`. The agent cannot see the screenshot. It didn't ask for clarification. Instead, it inferred the requirement from the text alone — a reasonable but catastrophically wrong inference.

**The chain:**

```
goal_misunderstanding → hallucinated_belief → reasoning_loop → task_failed
         ↑                      ↑                   ↑              ↑
    (Cognitive)           (Cognitive)          (Cognitive)     (Outcome)
  Parsed goal wrong    Built on unseen     Stuck editing      157 calls,
                       image inference     same 2 files       zero result
```

Recovery attempted: **no.** At event 081, the user sent a screenshot (evt_user_002). The agent continued working on the preview system.

**Why eval would miss this.** A traditional eval checks: did the agent produce code? Yes — 7 files, hundreds of lines. Did it run? It tried. Did it use relevant tools? `Read`, `Write`, `Bash` on project files. Every surface-level metric says this session is productive. The failure is directional, not operational.

---

## The Three-Layer Schema

These two cases forced a schema with three layers. Each layer answers a different question:

| Layer | Question | Example tags |
|-------|----------|--------------|
| **Outcome** | What did the user see? | `task_failed`, `task_partially_failed`, `task_boundary_violation`, `unsafe_action`, `silent_failure` |
| **Cognitive/Runtime** | What went wrong in the agent's reasoning? | `directive_override`, `plan_divergence`, `goal_misunderstanding`, `hallucinated_belief`, `reasoning_loop`, `context_desync` |
| **Tool Execution** | What went wrong at the tool call level? | `wrong_tool_called`, `hallucinated_result`, `tool_not_triggered`, `stale_observation` |

### Key design decision: tags don't cross layers.

This was the most important decision, and it came directly from Case A.

`scope_expansion` — our original flat label — is both a cognitive event (the agent *decided* to do more) and an outcome (the user *saw* the boundary explode). If we let it exist in both layers, the propagation chain collapses:

```
directive_override → scope_expansion → task_partially_failed
```

Split it into layer-specific tags, and the chain becomes:

```
directive_override → plan_divergence → task_boundary_violation → task_partially_failed
```

The second version has one more node. But that extra node carries the causal link: **Cognitive-layer `plan_divergence` is the direct cause of Outcome-layer `task_boundary_violation`.** This arrow tells you the intervention point is in the Cognitive layer, not the Outcome layer.

Cross-layer tags compress exactly the information that makes chains useful.

---

## What This Changes About Regression Testing

The standard approach to agent regression testing is snapshot-based: save the input, save the expected output, re-run, compare.

This doesn't work for LLM agents. The same trace re-run will produce different model outputs, different tool call sequences, and potentially different failures. You can't do deterministic replay.

The failure chain schema suggests a different approach: **property-based regression.**

Instead of asserting "the output matches," assert "the same failure pattern doesn't recur." Concretely:

For **Case A**, the regression criterion is:
> *Given the same prompt, does the agent stop and request confirmation after completing the symlink fix, rather than continuing to execute cron/water-tracking/memory tasks?*

For **Case B**, the regression criterion is:
> *Given the same prompt, does the agent identify the `[Image]` reference and ask for clarification, rather than inferring the requirement and starting a large-scale implementation?*

These are behavioral properties, not output snapshots. They survive model updates, prompt changes, and tool schema evolution. They test whether the *class* of failure recurs, not whether the *tokens* match.

This is closer to property-based testing than to snapshot testing — which makes sense, because agent failures are closer to distributed system incidents than to function return values.

---

## What We Recorded That Most Annotations Don't

Each failure annotation includes a `diagnosis` block with three fields that conventional evals skip:

**`why_eval_missed`** — Why would a pass/fail eval get this case wrong?

> *Case A: "Traditional eval only checks whether symlink was fixed. It was. The agent also registered unauthorized cron tasks and explored unrelated system configs — eval can't see these side effects."*

**`replay_oracle`** — What should a regression test actually check?

> *Case B: "Whether the agent asks for image description before starting implementation, or chooses to fix event bindings rather than building a preview system from scratch."*

**`ambiguities`** — Where did the annotator have to make a judgment call?

> *Case A: "Is evt_005 (realpath execution) investigation or unauthorized fixing? The user's follow-up retroactively authorized it, but the agent's intent at that moment is underdetermined."*

Recording ambiguities is not a weakness of the annotation — it's a feature. Real failures are messy. An annotation scheme that forces binary confidence on every judgment will produce annotations that look clean but silently disagree with reality.

---

## What's Missing

The Tool Execution layer has no real case behind it yet. Tags like `wrong_tool_called`, `hallucinated_result`, and `stale_observation` are there because they're architecturally necessary, but they haven't been tested against annotation. Some of them will turn out to be wrong or redundant when real cases arrive.

The Cognitive layer tag `directive_override` was demoted to low-confidence in Case A due to retroactive authorization. It needs a cleaner case — one where the agent unambiguously reads a constraint and violates it with no subsequent user correction.

Recovery tracking (`recovery_attempted`, `recovery_successful`) exists in the schema but both cases have `false/false`. We need a case where the agent actually tries to self-correct to validate whether the recovery fields capture enough information.

These gaps are fine. A schema with 23 tags and 2 annotated cases is not a finished taxonomy. It's a testable hypothesis about how to structure agent failure data. The next 8 cases will break it, and that's the point.

---

## Implementation

The schema is implemented as TypeScript types in [Drift](https://github.com/hugfeature/drift):

- **Type definitions**: `src/types/failure.ts` — `FailureChain`, `FailureNode`, three tag union types
- **Annotated fixtures**: `eval/fixtures-valid/case_011.json` (Case A), `eval/fixtures-valid/case_004.json` (Case B)
- **Integration**: `EvalFixture` type includes optional `failure_annotation` field

The propagation chain is a first-class data structure, not a comment or a label:

```typescript
interface FailureNode {
  layer: 'outcome' | 'cognitive' | 'tool_execution'
  tag: FailureTag
  evidence: string
  event_refs?: string[]        // anchored to specific events
  triggered_by?: FailureTag    // upstream cause
  confidence: 'high' | 'medium' | 'low'
}

interface FailureChain {
  root: FailureNode
  secondary: FailureNode[]
  outcomes: OutcomeTag[]
  propagation_path: FailureTag[]
  recovery_attempted: boolean
  recovery_successful: boolean
}
```

Each node in the chain points to specific events in the trace (`event_refs`), names its upstream cause (`triggered_by`), and declares the annotator's confidence. The chain is redundantly stored as both a structured tree (root/secondary/outcomes) and a flat path (propagation_path) because different consumers need different shapes.

---

## Conclusion

Agent failures are not labels. They are causal chains that propagate across layers of abstraction — from a cognitive misjudgment, through behavioral symptoms, to a user-visible outcome.

Flat taxonomies capture the outcome. Chains capture the mechanism. If you want to build regression tests that survive model updates, you need the mechanism.

The schema we built has 23 tags across 3 layers, 2 annotated cases, and explicit ambiguity records. It's small, incomplete, and derived entirely from real data. That's the point — a taxonomy that can't be broken by the next case isn't being tested hard enough.

---

*Drift is an open-source runtime observability system for autonomous agents. The failure taxonomy described here is available at `src/types/failure.ts`. We're looking for real agent failure cases to annotate — if you have traces of agents going wrong in interesting ways, [open an issue](https://github.com/hugfeature/drift/issues).*
