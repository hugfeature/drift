/**
 * Safety module types for Drift agent runtime protection.
 *
 * Detects dangerous operations that an agent should not perform without
 * explicit human authorization, regardless of drift status.
 */

export type SafetyRiskLevel = 'critical' | 'high' | 'medium' | 'low'

export type SafetyCategory =
  | 'destructive_command'      // rm -rf, DROP TABLE, format disk
  | 'sensitive_file_access'    // .env, private keys, credentials
  | 'data_exfiltration'        // curl/wget with sensitive data paths
  | 'privilege_escalation'     // sudo, chmod 777, chown root
  | 'network_exposure'         // binding 0.0.0.0, opening ports
  | 'secrets_in_output'        // API keys, tokens in stdout/logs

export interface SafetyRule {
  id: string
  category: SafetyCategory
  risk_level: SafetyRiskLevel
  description: string
  pattern: RegExp
  applies_to: SafetyRuleTarget
}

export type SafetyRuleTarget =
  | 'command'          // tool_input.command field
  | 'file_path'        // target or file_path field
  | 'output'           // tool_response stdout/stderr
  | 'message'          // event message field

export interface SafetyViolation {
  rule_id: string
  category: SafetyCategory
  risk_level: SafetyRiskLevel
  description: string
  matched_text: string
  event_id: string
  timestamp: number
}

export interface SafetyScanResult {
  violations: SafetyViolation[]
  highest_risk: SafetyRiskLevel | null
  requires_takeover: boolean
}

export interface SafetySummary {
  total_events_scanned: number
  total_violations: number
  violations_by_category: Record<SafetyCategory, number>
  violations_by_risk: Record<SafetyRiskLevel, number>
  highest_risk_seen: SafetyRiskLevel | null
}

export interface SafetyScannerConfig {
  enabled: boolean
  risk_threshold_for_takeover: SafetyRiskLevel
  custom_rules?: SafetyRule[]
}
