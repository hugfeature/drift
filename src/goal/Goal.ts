export type GoalSource = 'human' | 'system' | 'agent'
export type GoalStatus = 'active' | 'drifting' | 'forgotten' | 'replaced'

export interface GoalScope {
  observable_targets: string[]
  allowed_domains: string[]
  excluded_domains?: string[]
}

export interface Goal {
  id: string
  created_at: number
  source: GoalSource
  raw: string
  normalized?: GoalScope
  confirmed: boolean
  status: GoalStatus
  subgoal_depth: number
  parent_goal_id?: string
}
