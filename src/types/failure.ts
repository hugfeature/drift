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

// ─── Layer 4 (Orthogonal): Failure Domain ───────────────────────────────────
// NOT a fourth layer in the propagation chain.
// This is an orthogonal dimension that answers: "where in the system did this fail?"
//
// The three layers (Outcome/Cognitive/Tool) describe the WHAT and HOW.
// FailureDomain describes the WHERE — which system boundary the failure lives in.
//
// Key insight from case_063/064: some failures are not agent behavior problems
// but observability validity problems — "are we even watching the right thing?"

export type FailureDomain =
  | 'agent_runtime'          // failure in the agent's core reasoning/execution loop
  | 'tool_execution'         // failure at the tool call boundary
  | 'memory_layer'           // failure in persistent memory (engram, MEMORY.md, etc.)
  | 'workflow_state'         // failure in task/state tracking across sessions
  | 'observability_infra'    // failure in the instrumentation/monitoring itself
  | 'human_operator'         // failure due to human misconfiguration or oversight
  | 'external_dependency'    // failure in external service/API/model provider

// ─── Detectability ──────────────────────────────────────────────────────────
// "The most dangerous failures are silently non-observable."
//
// Traditional monitoring: no alert ≈ no problem.
// Agent systems: no data may itself BE the failure.
//
// This field captures how hard a failure is to notice.

export type Detectability = 'high' | 'medium' | 'low' | 'silent'

// ─── Cross-Session Context ──────────────────────────────────────────────────
// For failures that span multiple sessions — where the remediation session
// scores drift=0 but its existence proves the upstream session had undetected drift.

export interface CrossSessionContext {
  /** When the upstream failure occurred */
  upstream_session_date: string

  /** What the agent did in the upstream session (the partial work) */
  upstream_action: string

  /** What the agent should have done but didn't */
  missed_action: string

  /** How many days until someone noticed */
  detection_delay_days: number

  /** Who caught it — user discovery is the worst case */
  detected_by: 'user' | 'agent_self' | 'automated_check' | 'peer_agent'

  /** The remediation session's drift score (typically 0 — that's the paradox) */
  remediation_session_drift_score: number
}

// ─── Session Trigger Type ────────────────────────────────────────────────────
// Why does this session exist?
// A recovery session that scores drift=0 is still evidence of upstream failure.
// Hand-annotated only — no auto-inference, no LLM classifier.

export type SessionTriggerType =
  | 'new_intent'               // user starts genuinely new work
  | 'continuation'             // resuming interrupted or unfinished work
  | 'recovery'                 // fixing something a previous session left incomplete
  | 'verification'             // checking whether previous work actually landed

// ─── Failure Edge ────────────────────────────────────────────────────────────
// Many agent failures are only proven when a future session appears.
// A FailureEdge is a causal link between two sessions.
// Interface only — no graph engine, no traversal, no auto-inference.

export interface FailureEdge {
  /** The session where the failure originated */
  source_session_id: string

  /** The session where the failure was discovered/remediated */
  target_session_id: string

  /** What relationship the target has to the source */
  relation:
    | 'remediation_of'         // target fixes what source left incomplete
    | 'verification_of'        // target checks whether source actually worked
    | 'continuation_of'        // target resumes source's unfinished work

  /** If this edge implies a retroactive failure on the source session */
  inferred_failure?: string

  /** Confidence in the inferred failure */
  confidence?: 'high' | 'medium' | 'low'
}

// ─── Failure Fixture ─────────────────────────────────────────────────────────
// The minimal replayable unit of the failure corpus.
// Low-cost to fill → fast corpus growth. Annotation (deep RCA) is optional.
//
// Answers: "what happened, what was expected, what was actual, how to replay."

export interface FailureFixture {
  /** Unique fixture ID */
  fixture_id: string

  /** Links to the session where failure was observed */
  session_id: string

  /** Why this session exists */
  trigger_type: SessionTriggerType

  /** Primary failure (free text, will converge into tags with corpus growth) */
  root_failure: string

  /** Additional failures that compounded the root */
  secondary_failures?: string[]

  /** How hard this failure is to notice */
  detectability: Detectability

  /** Pointers to raw trace data (file paths, event IDs, log lines) */
  trace_refs: string[]

  /** What should have happened */
  expected_outcome: {
    task_completed: boolean
    workflow_closed: boolean
    observability_complete: boolean
  }

  /** What actually happened */
  actual_outcome: {
    task_completed: boolean
    workflow_closed: boolean
    observability_complete: boolean
  }
}

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

  /**
   * Orthogonal: which system boundary the failure lives in.
   * Not part of the propagation chain — answers WHERE, not WHAT/HOW.
   */
  failure_domain?: FailureDomain

  /**
   * How hard this failure is to detect.
   * 'silent' = no signal at all, absence of data IS the failure.
   */
  detectability?: Detectability

  /**
   * Cross-session context for failures where the remediation session
   * looks clean (drift=0) but its existence proves upstream drift.
   */
  cross_session?: CrossSessionContext
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

  /** Why does this session exist? Hand-annotated. */
  session_trigger_type?: SessionTriggerType

  /** Lightweight replayable fixture — the minimum corpus unit */
  failure_fixture?: FailureFixture

  /** Causal edges linking this session to other sessions */
  failure_edges?: FailureEdge[]

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
