# Publication Drafts

## 1. Hacker News — Show HN

**Title:** `Show HN: Agent failures are chains, not labels – a three-layer taxonomy from real traces`

**Body:**

Hi HN,

I built Drift (https://github.com/hugfeature/drift), a runtime observability system for autonomous agents. While annotating real failure cases, I found that flat labels like "hallucination" or "tool_error" are the agent equivalent of diagnosing a distributed systems outage from the HTTP status code.

Real agent failures propagate across layers: a cognitive misjudgment leads to behavioral symptoms, which produce a user-visible outcome. Example from a real session:

```
goal_misunderstanding → hallucinated_belief → reasoning_loop → task_failed
```

An agent told to "fix buttons that can't be clicked" spent 157 tool calls building an entire browser preview system from scratch — because it misunderstood what "can't click" meant. Every surface-level eval metric would say this session was productive (code written, tools used, files created). The failure is directional, not operational.

We designed a three-layer schema:
- Outcome Layer: what the user sees (task_failed, unsafe_action, silent_failure...)
- Cognitive Layer: what went wrong in reasoning (plan_divergence, directive_override, goal_misunderstanding...)  
- Tool Execution Layer: what went wrong at tool call level (wrong_tool_called, hallucinated_result...)

Key design decisions:
- Tags don't cross layers (forces explicit causal arrows between layers)
- Propagation chains, not single labels (each node has event-level evidence)
- Property-based regression instead of snapshot testing (test "does the same failure pattern recur?" not "does the output match?")

Full article: https://github.com/hugfeature/drift/blob/main/docs/article-failure-taxonomy.md

Schema: `src/types/failure.ts`  
Two annotated cases with event-level evidence in `eval/fixtures-valid/`

Looking for more real agent failure traces to annotate. If you have sessions where agents went wrong in interesting ways, I'd love to see them.

---

## 2. Twitter/X Thread

**Thread (5 tweets):**

---

**1/5**

Most agent evals label failures: "hallucination", "tool_error", "task_failed."

This is like diagnosing a distributed systems outage from the HTTP status code.

Real agent failures are propagation chains. We built a three-layer taxonomy from real traces. Here's what we found 🧵

---

**2/5**

Case A: User says "let's discuss first before deciding."

Agent investigates → gets authorized to execute → completes the fix → then keeps going: sets up cron jobs, organizes memory files, explores unrelated configs.

The failure isn't "did the wrong thing." It's "didn't stop."

Chain: plan_divergence → task_boundary_violation → task_partially_failed

---

**3/5**

Case B: User says "these buttons can't be clicked" + sends a screenshot.

Agent can't see the image. Doesn't ask. Instead, spends 157 tool calls building an entire browser preview system from scratch.

Reads mini-runtime.js 11 times. Writes it 6 times. Zero progress.

Chain: goal_misunderstanding → hallucinated_belief → reasoning_loop → task_failed

---

**4/5**

The schema has 3 layers:

• Outcome — what user sees
• Cognitive — what went wrong in reasoning  
• Tool Execution — what broke at tool level

Key rule: tags don't cross layers.

Why? Cross-layer tags compress the causal arrow — which is the most valuable part of the chain for RCA.

---

**5/5**

This isn't a finished taxonomy. It's 23 tags, 2 annotated cases, and explicit ambiguity records.

The Tool Execution layer has zero real cases behind it yet. Some tags will turn out wrong. That's the point.

Schema: github.com/hugfeature/drift (src/types/failure.ts)

Full writeup: [link to article]

Looking for real agent failure traces. If your agent went wrong in an interesting way, open an issue.

---

## 3. Reddit r/MachineLearning (Discussion post)

**Title:** `[D] We built a three-layer failure taxonomy for autonomous agents — flat labels can't capture propagation chains`

**Body:**

We've been building Drift, a runtime observability system for autonomous agents, and hit a wall with flat failure taxonomies. Labels like `scope_expansion` or `rabbit_hole` work for binary classification but fail at root cause analysis because they mix layers of abstraction and compress causal chains.

After annotating real failure cases, we redesigned the schema into three layers:

1. **Outcome Layer** — what the user sees (task_failed, task_boundary_violation, silent_failure)
2. **Cognitive/Runtime Layer** — what went wrong in the agent's reasoning (plan_divergence, goal_misunderstanding, directive_override)
3. **Tool Execution Layer** — concrete execution faults (wrong_tool_called, hallucinated_result)

The key insight: a single failure case produces a **propagation chain** across layers. Example:

```
goal_misunderstanding → hallucinated_belief → reasoning_loop → task_failed
```

This changes how you think about regression testing too — instead of snapshot testing (same input → same output), you do property-based testing (same trigger conditions → same failure pattern doesn't recur?).

Full article with two detailed case studies: https://github.com/hugfeature/drift/blob/main/docs/article-failure-taxonomy.md

Curious if others working on agent eval have hit similar problems with flat taxonomies. What failure patterns have you seen that don't fit neatly into a single label?

---

## 4. dev.to

**Title:** `Agent Failures Are Not Labels. They Are Chains.`

**Tags:** `ai`, `agents`, `observability`, `typescript`

**Body:** [直接复制 docs/article-failure-taxonomy.md 的全文，dev.to 支持 markdown]

**Cover image suggestion:** A diagram showing the propagation chain:
```
[Cognitive] → [Cognitive] → [Outcome] → [Outcome]
plan_divergence → task_boundary_violation → task_partially_failed
```
with arrows and layer colors (blue/orange/red).
