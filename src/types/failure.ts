/**
 * Three-layer failure taxonomy for Agent runtime failures.
 *
 * Design principle: real failures propagate across layers.
 * A single failure tag is a classification; a propagation chain is a diagnosis.
 *
 * Layer order matters:
 *   Tool Execution → Cognitive/Runtime → Outcome
 *   (root cause)     (internal behavior)   (user-visible result)
 *
 * Schema derived from real cases, not designed in abstract:
 *   - Case A (case_011): directive_override → plan_divergence → task_boundary_violation
 *   - Case B (case_004): goal_misunderstanding → reasoning_loop → task_failed
 *
 * Key insight: Agent failures are not one-time events. The agent continues
 * acting after failure, so failures evolve dynamically. Recovery tracking
 * is part of the schema, not an afterthought.
 */

// ─── Layer 1: Outcome Layer ─────────────────────────────────────────────────
// What the user sees. These are symptoms, not causes.

export type OutcomeTag =
  | 'task_failed'               // task produced no useful result
  | 'task_partially_failed'     // some subtasks completed, core goal unmet
  | 'task_abandoned'            // agent stopped working before completion
  | 'goal_mutation'             // original goal was silently replaced
  | 'unsafe_action'             // agent performed dangerous/unauthorized operation
  | 'silent_failure'            // agent reported success but outcome is wrong
  | 'task_boundary_violation'   // task "succeeded" but scope exploded beyond intent

// ─── Layer 2: Cognitive/Runtime Layer ────────────────────────────────────────
// What went wrong inside the agent's reasoning. These are the mechanisms.

export type CognitiveTag =
  | 'directive_override'        // agent read an explicit constraint and ignored it
  | 'plan_divergence'           // execution path deviates from stated/implied plan
  | 'context_desync'            // agent's mental model diverges from actual state
  | 'memory_corruption'         // agent references facts it fabricated or misrecalled
  | 'reasoning_loop'            // agent repeats the same reasoning without progress
  | 'tool_oscillation'          // agent alternates between tools without converging
  | 'state_loss'                // agent forgets what it already did or decided
  | 'hallucinated_belief'       // agent acts on something it believes but never verified
  | 'goal_misunderstanding'     // agent parsed the goal incorrectly from the start

// ─── Layer 3: Tool Execution Layer ──────────────────────────────────────────
// What went wrong at the tool call level. These are the concrete faults.

export type ToolFailureTag =
  | 'tool_not_triggered'        // expected tool call never happened
  | 'wrong_tool_called'         // agent called an inappropriate tool
  | 'invalid_tool_params'       // correct tool, wrong arguments
  | 'tool_timeout'              // tool call hung or exceeded time limit
  | 'hallucinated_result'       // agent fabricated a tool response
  | 'schema_mismatch'           // tool input/output didn't match expected schema
  | 'stale_observation'         // agent acted on outdated tool output

// ─── Unified tag type ───────────────────────────────────────────────────────

export type FailureTag = OutcomeTag | CognitiveTag | ToolFailureTag

export type FailureLayer = 'outcome' | 'cognitive' | 'tool_execution'

/** Resolve which layer a tag belongs to. */
export function getFailureLayer(tag: FailureTag): FailureLayer {
  const outcomeTags: ReadonlySet<string> = new Set<OutcomeTag>([
    'task_failed', 'task_partially_failed', 'task_abandoned',
    'goal_mutation', 'unsafe_action', 'silent_failure', 'task_boundary_violation',
  ])
  const cognitiveTags: ReadonlySet<string> = new Set<CognitiveTag>([
    'directive_override', 'plan_divergence', 'context_desync',
    'memory_corruption', 'reasoning_loop', 'tool_oscillation',
    'state_loss', 'hallucinated_belief', 'goal_misunderstanding',
  ])
  if (outcomeTags.has(tag)) return 'outcome'
  if (cognitiveTags.has(tag)) return 'cognitive'
  return 'tool_execution'
}

// ─── Failure Chain ──────────────────────────────────────────────────────────
// The propagation path is the diagnosis. Single tags are just classification.
//
// Example (Case A):
//   root:        directive_override        (cognitive)
//   secondary:   [plan_divergence]         (cognitive)
//   outcomes:    [task_boundary_violation, task_partially_failed, unsafe_action]
//   path:        directive_override → plan_divergence → task_boundary_violation → task_partially_failed
//
// The arrows matter more than the nodes — they tell you where to intervene.

/**
 * A single node in the failure propagation chain.
 * Each node is a failure that happened, with evidence pointing to specific events.
 */
export interface FailureNode {
  /** Which layer this failure belongs to */
  layer: FailureLayer

  /** The failure type */
  tag: FailureTag

  /** Human-readable description of what happened */
  evidence: string

  /** Event IDs where this failure is observable */
  event_refs?: string[]

  /** Which FailureNode triggered this one (tag of the upstream node) */
  triggered_by?: FailureTag

  /** Annotation confidence: high = clear evidence, low = judgment call */
  confidence: 'high' | 'medium' | 'low'
}

export interface FailureChain {
  /** The deepest cause we can identify. Usually Cognitive or Tool layer. */
  root: FailureNode

  /** Intermediate failures between root and outcome. Ordered by propagation. */
  secondary: FailureNode[]

  /** User-visible outcomes. Multiple outcomes are common. */
  outcomes: OutcomeTag[]

  /**
   * Full ordered propagation path from root cause to final outcome.
   * Redundant with root/secondary/outcomes but explicit for RCA tooling.
   * Each adjacent pair (path[i] → path[i+1]) is a causal link.
   */
  propagation_path: FailureTag[]

  /** Did the agent attempt any corrective action? */
  recovery_attempted: boolean

  /** If recovery was attempted, did it resolve the root failure? */
  recovery_successful: boolean

  /** Optional: what the agent did to try to recover */
  recovery_description?: string
}

// ─── Annotated Failure Case ─────────────────────────────────────────────────
// This is what a labeled failure case looks like in the corpus.
// It extends the existing DriftLabel with chain-level diagnosis.

export interface FailureAnnotation {
  /** Unique ID for this failure case (e.g. "FC-011-plan-divergence") */
  case_id: string

  /** Human-readable title */
  title: string

  /** Links to the session fixture */
  session_id: string

  /** The propagation chain — this is the core diagnosis */
  chain: FailureChain

  /**
   * Trigger conditions that would reproduce this failure class.
   * Not the exact inputs (that's snapshot testing), but the structural
   * conditions under which this failure pattern emerges.
   * Used for property-based regression.
   */
  trigger_conditions: TriggerCondition[]

  /**
   * What "still failing" means for regression testing.
   * Not token-level output match — it's "does the same failure path recur?"
   */
  regression_criterion: string

  /** Diagnosis metadata — why existing eval would miss this */
  diagnosis?: FailureDiagnosis

  /** Human notes on why this chain was annotated this way */
  annotator_notes?: string

  /** When this annotation was created */
  annotated_at: number
}

/**
 * Diagnosis metadata explaining why this failure matters
 * and how it relates to existing evaluation approaches.
 */
export interface FailureDiagnosis {
  /** Why a traditional pass/fail eval would miss this failure */
  why_eval_missed?: string

  /**
   * What a replay/regression oracle should check.
   * Describes the property to test, not the expected output.
   */
  replay_oracle?: string

  /**
   * Ambiguities encountered during annotation.
   * Real failures are messy — recording the uncertainty is part of the data.
   */
  ambiguities?: string[]
}

/**
 * Structural condition that triggers a failure class.
 * For property-based regression: same conditions → same failure type?
 */
export interface TriggerCondition {
  /** What aspect of the input matters */
  dimension: 'prompt_contains_action_gate'  // e.g. "先讨论再说"
    | 'context_length_exceeds'               // context window pressure
    | 'tool_schema_ambiguity'                // multiple tools could match
    | 'goal_requires_image_understanding'    // goal references visual content
    | 'multi_turn_with_interruption'         // user interrupts mid-task
    | 'long_running_autonomous'              // extended unsupervised execution
    | string                                 // extensible for new dimensions

  /** Human-readable description of the condition */
  description: string

  /** Optional: specific value or threshold */
  value?: string | number
}
