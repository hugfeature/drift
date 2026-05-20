/**
 * SafetyScanner: runtime safety guard for agent actions.
 *
 * Scans each tool_call event against built-in + custom safety rules.
 * Produces SafetyViolation records and determines if human takeover is needed.
 */

import type { RuntimeEvent } from '../types/event'
import type {
  SafetyRule,
  SafetyRuleTarget,
  SafetyViolation,
  SafetyScanResult,
  SafetySummary,
  SafetyScannerConfig,
  SafetyRiskLevel,
  SafetyCategory,
} from './types'
import { BUILT_IN_RULES } from './rules'

const DEFAULT_CONFIG: SafetyScannerConfig = {
  enabled: true,
  risk_threshold_for_takeover: 'high',
}

const RISK_SEVERITY: Record<SafetyRiskLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

export type { SafetyScannerConfig } from './types'

export class SafetyScanner {
  private config: SafetyScannerConfig
  private rules: SafetyRule[]
  private allViolations: SafetyViolation[] = []
  private eventsScanned = 0

  constructor(config?: Partial<SafetyScannerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.rules = [...BUILT_IN_RULES, ...(this.config.custom_rules ?? [])]
  }

  /**
   * Scan a single event for safety violations.
   * Returns scan result with any violations found.
   */
  scan(event: RuntimeEvent): SafetyScanResult {
    if (!this.config.enabled || event.type !== 'tool_call') {
      return { violations: [], highest_risk: null, requires_takeover: false }
    }

    this.eventsScanned++
    const violations: SafetyViolation[] = []
    const payload = event.payload as Record<string, unknown>

    for (const rule of this.rules) {
      const textToCheck = this.extractText(payload, rule.applies_to)
      if (!textToCheck) continue

      const match = rule.pattern.exec(textToCheck)
      if (match) {
        violations.push({
          rule_id: rule.id,
          category: rule.category,
          risk_level: rule.risk_level,
          description: rule.description,
          matched_text: match[0].slice(0, 100),
          event_id: event.id,
          timestamp: event.timestamp,
        })
      }
    }

    this.allViolations.push(...violations)

    const highestRisk = this.getHighestRisk(violations)
    const requiresTakeover = highestRisk !== null &&
      RISK_SEVERITY[highestRisk] >= RISK_SEVERITY[this.config.risk_threshold_for_takeover]

    return { violations, highest_risk: highestRisk, requires_takeover: requiresTakeover }
  }

  /**
   * Get cumulative safety summary across all scanned events.
   */
  getSummary(): SafetySummary {
    const byCategory = {} as Record<SafetyCategory, number>
    const byRisk = {} as Record<SafetyRiskLevel, number>

    for (const violation of this.allViolations) {
      byCategory[violation.category] = (byCategory[violation.category] ?? 0) + 1
      byRisk[violation.risk_level] = (byRisk[violation.risk_level] ?? 0) + 1
    }

    return {
      total_events_scanned: this.eventsScanned,
      total_violations: this.allViolations.length,
      violations_by_category: byCategory,
      violations_by_risk: byRisk,
      highest_risk_seen: this.getHighestRisk(this.allViolations),
    }
  }

  getViolationCount(): number {
    return this.allViolations.length
  }

  getViolations(): SafetyViolation[] {
    return [...this.allViolations]
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private extractText(payload: Record<string, unknown>, target: SafetyRuleTarget): string | null {
    switch (target) {
      case 'command': {
        const toolInput = payload['tool_input'] as Record<string, unknown> | undefined
        return (toolInput?.['command'] as string) ?? null
      }
      case 'file_path': {
        const filePath = (payload['target'] as string)
          ?? (payload['file_path'] as string)
          ?? ((payload['tool_input'] as Record<string, unknown>)?.['file_path'] as string)
        return filePath ?? null
      }
      case 'output': {
        const response = payload['tool_response'] as Record<string, unknown> | undefined
        if (!response) return null
        const stdout = (response['stdout'] as string) ?? ''
        const stderr = (response['stderr'] as string) ?? ''
        return stdout + '\n' + stderr
      }
      case 'message': {
        return (payload['message'] as string) ?? null
      }
      default:
        return null
    }
  }

  private getHighestRisk(violations: SafetyViolation[]): SafetyRiskLevel | null {
    if (violations.length === 0) return null
    let highest: SafetyRiskLevel = 'low'
    for (const violation of violations) {
      if (RISK_SEVERITY[violation.risk_level] > RISK_SEVERITY[highest]) {
        highest = violation.risk_level
      }
    }
    return highest
  }
}
