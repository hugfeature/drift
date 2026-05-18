/**
 * Narrative types for Drift runtime interpretation.
 *
 * Narrative is not a UI layer. It is a runtime interpretation layer.
 *
 * The narrative engine converts:
 *   raw event stream + drift scores
 *   →
 *   human-readable runtime story
 *
 * This is the "Git Blame for Autonomous Agents":
 * Why did the agent start drifting at 14:32?
 * Who introduced the new goal?
 * Why was takeover not triggered?
 *
 * NarrativeSegment is the atomic unit of session story reconstruction.
 *
 * Example output:
 *   T+0m  Human created goal: fix login bug
 *   T+8m  Agent refined goal: OAuth token refresh issue identified
 *   T+14m Scope expansion detected: eslint upgrade introduced
 *   T+21m Original goal inactive: no aligned actions in 10 minutes
 *   T+28m Drift escalated: score 0.82, subgoal depth 4
 *   T+31m Human takeover recommended
 */

export type NarrativeCategory =
  | 'alignment'     // agent actively working toward goal
  | 'drift'         // divergence from goal detected
  | 'mutation'      // goal was created, refined, expanded, or replaced
  | 'exploration'   // unrelated but not yet classified as drift
  | 'takeover'      // governance intervention point

export interface NarrativeSegment {
  id: string
  session_id: string
  timestamp: number
  category: NarrativeCategory
  summary: string                     // human-readable, one sentence
  supporting_event_ids: string[]      // events that generated this segment
  drift_score_at_time?: number        // score context at this moment
}

export interface SessionNarrative {
  session_id: string
  generated_at: number
  segments: NarrativeSegment[]        // ordered by timestamp
  overall_summary: string             // one paragraph session summary
}