/**
 * Built-in safety rules for Drift agent runtime protection.
 *
 * Rules detect dangerous operations across 6 categories:
 *   - destructive_command: irreversible system/data destruction
 *   - sensitive_file_access: credentials, keys, secrets
 *   - data_exfiltration: sending data to external endpoints
 *   - privilege_escalation: gaining elevated permissions
 *   - network_exposure: opening services to external access
 *   - secrets_in_output: leaking credentials in logs/stdout
 */

import type { SafetyRule } from './types'

export const BUILT_IN_RULES: SafetyRule[] = [
  // ─── Destructive Commands ───────────────────────────────────────────────────
  {
    id: 'destructive_rm_rf',
    category: 'destructive_command',
    risk_level: 'critical',
    description: 'Recursive force deletion (rm -rf) on broad paths',
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\b).*\s+(\/|~|\$HOME|\.\.|\.\/\.\.)/,
    applies_to: 'command',
  },
  {
    id: 'destructive_rm_root',
    category: 'destructive_command',
    risk_level: 'critical',
    description: 'Deletion targeting root or home directory',
    pattern: /\brm\s+.*\s+(\/\s*$|\/\*|~\/\*)/,
    applies_to: 'command',
  },
  {
    id: 'destructive_drop_table',
    category: 'destructive_command',
    risk_level: 'critical',
    description: 'SQL DROP TABLE/DATABASE statement',
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    applies_to: 'command',
  },
  {
    id: 'destructive_truncate',
    category: 'destructive_command',
    risk_level: 'high',
    description: 'SQL TRUNCATE TABLE statement',
    pattern: /\bTRUNCATE\s+TABLE\b/i,
    applies_to: 'command',
  },
  {
    id: 'destructive_format_disk',
    category: 'destructive_command',
    risk_level: 'critical',
    description: 'Disk formatting commands (mkfs, format)',
    pattern: /\b(mkfs|format)\b.*\/(dev|disk)/i,
    applies_to: 'command',
  },
  {
    id: 'destructive_dd_device',
    category: 'destructive_command',
    risk_level: 'critical',
    description: 'dd writing to block devices',
    pattern: /\bdd\b.*\bof=\/(dev\/[a-z])/,
    applies_to: 'command',
  },
  {
    id: 'destructive_git_force_push',
    category: 'destructive_command',
    risk_level: 'high',
    description: 'Force push to remote (potentially destructive)',
    pattern: /\bgit\s+push\s+.*--force\b/,
    applies_to: 'command',
  },

  // ─── Sensitive File Access ──────────────────────────────────────────────────
  {
    id: 'sensitive_env_file',
    category: 'sensitive_file_access',
    risk_level: 'high',
    description: 'Accessing .env files (may contain secrets)',
    pattern: /\.(env|env\.local|env\.production|env\.secret)\b/,
    applies_to: 'file_path',
  },
  {
    id: 'sensitive_private_key',
    category: 'sensitive_file_access',
    risk_level: 'critical',
    description: 'Accessing private key files',
    pattern: /(id_rsa|id_ed25519|\.pem|\.key|private[_-]?key)/i,
    applies_to: 'file_path',
  },
  {
    id: 'sensitive_credentials',
    category: 'sensitive_file_access',
    risk_level: 'high',
    description: 'Accessing credential/password files',
    pattern: /(credentials|passwords?|secrets?|\.htpasswd|\.netrc)/i,
    applies_to: 'file_path',
  },
  {
    id: 'sensitive_ssh_config',
    category: 'sensitive_file_access',
    risk_level: 'medium',
    description: 'Accessing SSH config or known_hosts',
    pattern: /\.ssh\/(config|known_hosts|authorized_keys)/,
    applies_to: 'file_path',
  },
  {
    id: 'sensitive_aws_creds',
    category: 'sensitive_file_access',
    risk_level: 'critical',
    description: 'Accessing AWS/cloud credential files',
    pattern: /\.(aws|gcloud|azure)\/(credentials|config)/,
    applies_to: 'file_path',
  },

  // ─── Data Exfiltration ──────────────────────────────────────────────────────
  {
    id: 'exfil_curl_post_sensitive',
    category: 'data_exfiltration',
    risk_level: 'high',
    description: 'curl/wget POST with file containing potential secrets',
    pattern: /\b(curl|wget)\b.*(-d\s*@|-F\s*file=|--data-binary\s*@).*\.(env|key|pem|credentials)/i,
    applies_to: 'command',
  },
  {
    id: 'exfil_pipe_to_remote',
    category: 'data_exfiltration',
    risk_level: 'high',
    description: 'Piping sensitive data to remote endpoint',
    pattern: /\bcat\b.*\.(env|key|pem|secret).*\|\s*(curl|nc|netcat)\b/i,
    applies_to: 'command',
  },
  {
    id: 'exfil_base64_upload',
    category: 'data_exfiltration',
    risk_level: 'medium',
    description: 'Base64 encoding followed by network upload',
    pattern: /\bbase64\b.*\|\s*(curl|wget|nc)\b/,
    applies_to: 'command',
  },

  // ─── Privilege Escalation ───────────────────────────────────────────────────
  {
    id: 'priv_sudo',
    category: 'privilege_escalation',
    risk_level: 'high',
    description: 'Using sudo for elevated privileges',
    pattern: /\bsudo\b/,
    applies_to: 'command',
  },
  {
    id: 'priv_chmod_world_writable',
    category: 'privilege_escalation',
    risk_level: 'high',
    description: 'Setting world-writable permissions (chmod 777/666)',
    pattern: /\bchmod\s+(777|666|a\+w)\b/,
    applies_to: 'command',
  },
  {
    id: 'priv_chown_root',
    category: 'privilege_escalation',
    risk_level: 'high',
    description: 'Changing ownership to root',
    pattern: /\bchown\s+(root|0:0)\b/,
    applies_to: 'command',
  },
  {
    id: 'priv_setuid',
    category: 'privilege_escalation',
    risk_level: 'critical',
    description: 'Setting SUID/SGID bits',
    pattern: /\bchmod\s+[0-7]*[4-7][0-7]{2}\b|\bu\+s\b|\bg\+s\b/,
    applies_to: 'command',
  },

  // ─── Network Exposure ───────────────────────────────────────────────────────
  {
    id: 'net_bind_all_interfaces',
    category: 'network_exposure',
    risk_level: 'medium',
    description: 'Binding to 0.0.0.0 (all interfaces)',
    pattern: /\b(0\.0\.0\.0|INADDR_ANY)\b/,
    applies_to: 'command',
  },
  {
    id: 'net_expose_port',
    category: 'network_exposure',
    risk_level: 'medium',
    description: 'Opening firewall port or iptables rule',
    pattern: /\b(iptables|ufw|firewall-cmd)\b.*\b(ACCEPT|allow)\b/i,
    applies_to: 'command',
  },
  {
    id: 'net_ngrok_tunnel',
    category: 'network_exposure',
    risk_level: 'high',
    description: 'Creating public tunnel (ngrok, localtunnel)',
    pattern: /\b(ngrok|lt|localtunnel)\b.*\b(http|tcp)\b/,
    applies_to: 'command',
  },

  // ─── Secrets in Output ──────────────────────────────────────────────────────
  {
    id: 'secret_api_key_in_output',
    category: 'secrets_in_output',
    risk_level: 'high',
    description: 'API key pattern detected in command output',
    pattern: /\b(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36})\b/,
    applies_to: 'output',
  },
  {
    id: 'secret_token_in_output',
    category: 'secrets_in_output',
    risk_level: 'high',
    description: 'Bearer/auth token pattern in output',
    pattern: /\b(Bearer\s+[a-zA-Z0-9._~+/=-]{20,}|token[=:]\s*[a-zA-Z0-9._~+/=-]{20,})\b/i,
    applies_to: 'output',
  },
  {
    id: 'secret_private_key_block',
    category: 'secrets_in_output',
    risk_level: 'critical',
    description: 'Private key material in output',
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    applies_to: 'output',
  },
]
