/**
 * Risk Layer v0.1 — Tool → Domain mapping
 * Per RFC §3.3: Bash events MUST be sub-classified by payload inspection.
 */

import type { Domain } from './types'

const TOOL_DOMAIN_MAP: Record<string, Domain> = {
  // code
  'Edit': 'code',
  'Write': 'code',
  // read
  'Read': 'read',
  'Grep': 'read',
  'Glob': 'read',
  'read': 'read',
  // task_mgmt
  'TaskCreate': 'task_mgmt',
  'TaskUpdate': 'task_mgmt',
  'TaskOutput': 'task_mgmt',
  'Agent': 'task_mgmt',
  // browser
  'web_fetch': 'browser',
  'WebFetch': 'browser',
  'WebSearch': 'browser',
  'web_search': 'browser',
  // code (lowercase variants)
  'edit': 'code',
  'write': 'code',
  'edit_file': 'code',
  'bash': 'code',
  // read (lowercase variants)
  'read_file': 'read',
  // task_mgmt
  'TodoWrite': 'task_mgmt',
  'TaskStop': 'task_mgmt',
  'TaskList': 'task_mgmt',
  'AskUserQuestion': 'task_mgmt',
  'ExitPlanMode': 'task_mgmt',
  'EnterPlanMode': 'task_mgmt',
  'update_plan': 'task_mgmt',
  'Skill': 'task_mgmt',
  'sessions_list': 'task_mgmt',
  'session_status': 'task_mgmt',
  'message': 'task_mgmt',
  'memory_search': 'task_mgmt',
  'memory_get': 'task_mgmt',
  'ListMcpResourcesTool': 'task_mgmt',
  'cron': 'task_mgmt',
}

/** Prefix patterns for MCP tools */
const MCP_DOMAIN_RULES: Array<{ pattern: RegExp; domain: Domain }> = [
  { pattern: /^mcp__engram__/, domain: 'task_mgmt' },
  { pattern: /^mcp__yuque/, domain: 'browser' },
  { pattern: /^mcp__observmcp__/, domain: 'read' },
  { pattern: /^mcp__browser/, domain: 'browser' },
  { pattern: /^mcp__codefusesearchmcp__web/, domain: 'browser' },
  { pattern: /^mcp__antcode/, domain: 'read' },
  { pattern: /^mcp__dima__/, domain: 'task_mgmt' },
  { pattern: /^mcp__plugin_playwright/, domain: 'browser' },
  { pattern: /^mcp__localmemory__/, domain: 'task_mgmt' },
  { pattern: /^mcp__yourmemory__/, domain: 'task_mgmt' },
]

/** Bash command prefix → domain */
/** Rules for raw shell commands */
const BASH_COMMAND_RULES: Array<{ pattern: RegExp; domain: Domain }> = [
  { pattern: /\bgit\s/, domain: 'git' },
  { pattern: /\bgit$/, domain: 'git' },
  { pattern: /\b(cat|head|tail|less|grep|awk|sed|wc)\s/, domain: 'read' },
  { pattern: /\b(ls|find|stat|du|df|tree|realpath|dirname|basename)\s/, domain: 'filesystem' },
  { pattern: /\b(ls|find|tree)$/, domain: 'filesystem' },
  { pattern: /\b(mkdir|rm|mv|cp|chmod|chown|ln|touch)\s/, domain: 'filesystem' },
  { pattern: /\b(npm\s+test|npx\s+jest|jest|pytest|vitest|mocha)\b/, domain: 'test' },
  { pattern: /\b(curl|wget|fetch|http)\s/, domain: 'browser' },
  { pattern: /\b(echo|printf|tee)\s.*>/, domain: 'code' },
  { pattern: /\b(node|ts-node|python|python3)\s/, domain: 'code' },
]

/**
 * Rules for natural-language Bash descriptions (e.g. "Check git status",
 * "List project structure"). Many fixture payloads use semantic summaries
 * instead of raw shell commands.
 */
const BASH_SEMANTIC_RULES: Array<{ pattern: RegExp; domain: Domain }> = [
  // git
  { pattern: /\b(git\s|commit|branch|merge|rebase|cherry.pick|stash|pull|push|clone|diff\b|log\b|blame)\b/i, domain: 'git' },
  { pattern: /\buncommitted\s+changes\b/i, domain: 'git' },
  // read / inspect
  { pattern: /\b(check|verify|inspect|view|show|read|look\s+at|examine|review|confirm|see)\s/i, domain: 'read' },
  { pattern: /\b(syntax\s+check|content\s+of)\b/i, domain: 'read' },
  // filesystem / list / structure
  { pattern: /\b(list|directory|structure|files?\s+in|folder|tree)\b/i, domain: 'filesystem' },
  // test
  { pattern: /\b(test|spec|jest|pytest|vitest|mocha|coverage)\b/i, domain: 'test' },
  // code / edit / write / run
  { pattern: /\b(edit|write|create|modify|update|add|remove|delete|replace|fix|patch|implement)\s/i, domain: 'code' },
  { pattern: /\b(run|execute|start|build|compile|install|deploy)\s/i, domain: 'code' },
  // browser
  { pattern: /\b(curl|wget|fetch|http|url|browser|navigate|download)\b/i, domain: 'browser' },
]

/**
 * Sub-classify a Bash event by inspecting its payload message/command.
 * Tries raw command patterns first, then semantic description patterns.
 * Returns 'unknown' if no pattern matches.
 */
export function classifyBashCommand(messageOrCommand: string): Domain {
  const trimmed = messageOrCommand.trim()

  // Try raw shell command patterns first (more precise)
  for (const rule of BASH_COMMAND_RULES) {
    if (rule.pattern.test(trimmed)) {
      return rule.domain
    }
  }

  // Fall back to semantic/NL description patterns
  for (const rule of BASH_SEMANTIC_RULES) {
    if (rule.pattern.test(trimmed)) {
      return rule.domain
    }
  }

  return 'unknown'
}

/**
 * Map a tool_name + optional payload to a Domain.
 * Bash/exec events require payload inspection for sub-classification.
 */
export function mapToolToDomain(
  toolName: string,
  payloadMessage?: string,
): Domain {
  // Direct lookup
  const direct = TOOL_DOMAIN_MAP[toolName]
  if (direct) return direct

  // MCP tools
  for (const rule of MCP_DOMAIN_RULES) {
    if (rule.pattern.test(toolName)) {
      return rule.domain
    }
  }

  // Bash / exec — sub-classify by payload
  if (toolName === 'Bash' || toolName === 'exec' || toolName === 'process') {
    if (payloadMessage) {
      return classifyBashCommand(payloadMessage)
    }
    return 'unknown'
  }

  return 'unknown'
}
