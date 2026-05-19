/**
 * GoalStore: Goal Lifecycle state machine.
 *
 * This is the runtime source of truth for goal state.
 * All transitions are explicit. No implicit state changes.
 *
 * Valid transitions:
 *   (none)    → active     [create]
 *   active    → active     [confirm, refine]
 *   active    → drifting   [markDrifting]
 *   active    → forgotten  [markForgotten]
 *   active    → replaced   [replace]
 *   drifting  → active     [recover]
 *   drifting  → forgotten  [markForgotten]
 *   drifting  → replaced   [replace]
 *   forgotten → replaced   [replace]
 *
 * Invalid transitions throw — callers must handle errors.
 */

import type { Goal, GoalScope, GoalSource, GoalStatus } from '../types/goal'
import type { GoalMutation, MutationType } from '../types/mutation'

// Mutation authority table from goal-model-v0:
//   Human:  create ✓  refine ✓  expand ✓  replace ✓  cancel ✓
//   System: create ✗  refine ✓  expand suggest-only  replace ✗  cancel ✗
//   Agent:  create ✗  refine ✓ (within scope)  expand suggest-only  replace ✗  cancel ✗
const MUTATION_AUTHORITY: Record<MutationType, GoalSource[]> = {
  refine:  ['human', 'system', 'agent'],
  expand:  ['human'],                    // system/agent may suggest, not execute
  replace: ['human'],
  cancel:  ['human'],
}

function isAuthorized(source: GoalSource, mutationType: MutationType): boolean {
  return MUTATION_AUTHORITY[mutationType].includes(source)
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export class GoalStore {
  private goals: Map<string, Goal> = new Map()
  private mutations: GoalMutation[] = []
  private session_id: string

  constructor(session_id: string) {
    this.session_id = session_id
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * Create a new goal from human input.
   * Only humans may create goals.
   */
  create(raw: string, created_at?: number): Goal {
    const goal: Goal = {
      id: generateId('goal'),
      created_at: created_at ?? Date.now(),
      source: 'human',
      raw,
      confirmed: false,
      status: 'active',
      subgoal_depth: 0,
    }
    this.goals.set(goal.id, goal)
    return goal
  }

  /**
   * Create an agent subgoal under a parent goal.
   * Depth is tracked and automatically incremented.
   *
   * Throws if:
   *   - parent goal does not exist
   *   - parent goal is not active or drifting
   */
  createSubgoal(raw: string, parent_goal_id: string): Goal {
    const parent = this.getOrThrow(parent_goal_id)

    if (parent.status === 'forgotten' || parent.status === 'replaced') {
      throw new Error(
        `Cannot create subgoal under ${parent.status} goal "${parent_goal_id}"`
      )
    }

    const depth = parent.subgoal_depth + 1

    const goal: Goal = {
      id: generateId('goal'),
      created_at: Date.now(),
      source: 'agent',
      raw,
      confirmed: false,      // subgoals do not require human confirmation
      status: 'active',
      subgoal_depth: depth,
      parent_goal_id,
    }

    this.goals.set(goal.id, goal)
    return goal
  }

  // ---------------------------------------------------------------------------
  // Confirmation
  // ---------------------------------------------------------------------------

  /**
   * Confirm a goal's normalized scope.
   * Only meaningful for goals with LLM-inferred normalization.
   * Sets confirmed = true, enabling scope-based drift detection.
   */
  confirm(goalId: string, normalized: GoalScope): Goal {
    const goal = this.getOrThrow(goalId)
    const updated: Goal = { ...goal, normalized, confirmed: true }
    this.goals.set(goalId, updated)
    return updated
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Refine a goal (narrow scope, same intent).
   * Agents may refine within scope. Humans may refine freely.
   *
   * Refinement does NOT change GoalStatus.
   * It updates the raw description and resets confirmed = false
   * so normalization can be re-run.
   */
  refine(goalId: string, newRaw: string, source: GoalSource): Goal {
    const goal = this.getOrThrow(goalId)
    this.assertStatus(goal, ['active', 'drifting'], 'refine')

    const authorized = isAuthorized(source, 'refine')
    this.recordMutation({
      from_goal_id: goalId,
      to_goal_id: goalId,
      source,
      mutation_type: 'refine',
      authorized,
    })

    if (!authorized) {
      throw new Error(`${source} is not authorized to refine goals`)
    }

    const updated: Goal = {
      ...goal,
      raw: newRaw,
      confirmed: false,      // normalization must be re-confirmed
      normalized: undefined,
    }
    this.goals.set(goalId, updated)
    return updated
  }

  /**
   * Replace the active goal entirely.
   * Only humans may replace goals.
   *
   * Creates a new goal. Marks the old goal as replaced.
   * The new goal inherits no lineage from the old goal.
   */
  replace(oldGoalId: string, newRaw: string, source: GoalSource): Goal {
    const oldGoal = this.getOrThrow(oldGoalId)

    const authorized = isAuthorized(source, 'replace')
    this.recordMutation({
      from_goal_id: oldGoalId,
      source,
      mutation_type: 'replace',
      authorized,
    })

    if (!authorized) {
      throw new Error(`${source} is not authorized to replace goals`)
    }

    // Mark old goal replaced
    this.goals.set(oldGoalId, { ...oldGoal, status: 'replaced' })

    // Create new goal
    const newGoal: Goal = {
      id: generateId('goal'),
      created_at: Date.now(),
      source: 'human',
      raw: newRaw,
      confirmed: false,
      status: 'active',
      subgoal_depth: 0,
    }
    this.goals.set(newGoal.id, newGoal)
    return newGoal
  }

  /**
   * Cancel a goal.
   * Only humans may cancel. Treated as replace with no successor.
   */
  cancel(goalId: string, source: GoalSource): Goal {
    const goal = this.getOrThrow(goalId)

    const authorized = isAuthorized(source, 'cancel')
    this.recordMutation({
      from_goal_id: goalId,
      source,
      mutation_type: 'cancel',
      authorized,
    })

    if (!authorized) {
      throw new Error(`${source} is not authorized to cancel goals`)
    }

    const updated: Goal = { ...goal, status: 'replaced' }
    this.goals.set(goalId, updated)
    return updated
  }

  // ---------------------------------------------------------------------------
  // Drift transitions
  // ---------------------------------------------------------------------------

  /**
   * Transition an active goal to drifting.
   * Called by the drift scorer when threshold is crossed.
   */
  markDrifting(goalId: string): Goal {
    const goal = this.getOrThrow(goalId)
    this.assertStatus(goal, ['active'], 'markDrifting')
    const updated: Goal = { ...goal, status: 'drifting' }
    this.goals.set(goalId, updated)
    return updated
  }

  /**
   * Transition a drifting goal back to active.
   * Called when drift score falls below threshold (agent corrected).
   */
  recover(goalId: string): Goal {
    const goal = this.getOrThrow(goalId)
    this.assertStatus(goal, ['drifting'], 'recover')
    const updated: Goal = { ...goal, status: 'active' }
    this.goals.set(goalId, updated)
    return updated
  }

  /**
   * Mark a goal as forgotten.
   * Triggered when Goal Forgotten heuristic fires:
   *   - 5 consecutive unrelated actions
   *   - 10 minute inactive goal window
   */
  markForgotten(goalId: string): Goal {
    const goal = this.getOrThrow(goalId)
    this.assertStatus(goal, ['active', 'drifting'], 'markForgotten')
    const updated: Goal = { ...goal, status: 'forgotten' }
    this.goals.set(goalId, updated)
    return updated
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getActive(): Goal | null {
    for (const goal of this.goals.values()) {
      if (goal.status === 'active' || goal.status === 'drifting') {
        if (!goal.parent_goal_id) return goal   // top-level goal only
      }
    }
    return null
  }

  getById(id: string): Goal | undefined {
    return this.goals.get(id)
  }

  getAll(): Goal[] {
    return Array.from(this.goals.values()).sort((a, b) => a.created_at - b.created_at)
  }

  getMutations(): GoalMutation[] {
    return [...this.mutations]
  }

  getUnauthorizedMutations(): GoalMutation[] {
    return this.mutations.filter(m => !m.authorized)
  }

  /**
   * Resolve the full lineage chain for a goal.
   * Returns [root, ..., goal] ordered from oldest ancestor to given goal.
   *
   * Used for orphan subgoal detection:
   * if lineage cannot trace back to the active human goal,
   * the subgoal is an unauthorized execution branch.
   */
  getLineage(goalId: string): Goal[] {
    const chain: Goal[] = []
    let current = this.goals.get(goalId)
    const visited = new Set<string>()

    while (current) {
      if (visited.has(current.id)) break   // cycle guard
      visited.add(current.id)
      chain.unshift(current)
      current = current.parent_goal_id
        ? this.goals.get(current.parent_goal_id)
        : undefined
    }

    return chain
  }

  /**
   * Check whether a subgoal can trace its lineage back to the current active goal.
   * Returns false = orphan subgoal = governance violation.
   */
  isOrphan(goalId: string): boolean {
    const active = this.getActive()
    if (!active) return true
    const lineage = this.getLineage(goalId)
    return !lineage.some(g => g.id === active.id)
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getOrThrow(id: string): Goal {
    const goal = this.goals.get(id)
    if (!goal) throw new Error(`Goal not found: ${id}`)
    return goal
  }

  private assertStatus(goal: Goal, allowed: GoalStatus[], operation: string): void {
    if (!allowed.includes(goal.status)) {
      throw new Error(
        `Cannot ${operation} goal "${goal.id}": status is "${goal.status}", expected one of [${allowed.join(', ')}]`
      )
    }
  }

  private recordMutation(params: Omit<GoalMutation, 'id' | 'session_id' | 'timestamp'>): void {
    this.mutations.push({
      id: generateId('mut'),
      session_id: this.session_id,
      timestamp: Date.now(),
      ...params,
    })
  }
}