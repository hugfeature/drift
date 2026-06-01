/**
 * Goal sanitization — the single source of truth for "is this text a real
 * user goal, or transcript/runtime machinery?"
 *
 * This module exists because goal capture has two ingestion paths that were
 * drifting apart:
 *   - Real-time:  scripts/claude-hook.ts pulls payload['prompt'] from the
 *                 UserPromptSubmit hook.
 *   - Offline:    scripts/import-claude-transcript.ts reverse-engineers goals
 *                 from a transcript's type:user messages.
 *
 * Both must reject the same noise, or the corpus gets polluted. A 2026-06-01
 * census of 114 fresh sessions found 81 with a polluted "goal" — interruption
 * markers and skill-injected system text. This module centralizes that filter
 * so a newly discovered pollution pattern is fixed in exactly one place.
 */

/**
 * Prefixes that mark a user-message text as transcript/runtime machinery
 * rather than a genuine instruction. A text starting with any of these is
 * never a real goal.
 */
const SYSTEM_PROMPT_PREFIXES = [
  // Transcript machinery (Claude Code / CodeFuse)
  'This session is being continued',
  '[Request interrupted by user',
  'Caveat: The messages below',
  '<command-name>',
  '<local-command-stdout>',
  // Skill-injected system text — surfaced as a "prompt" in skill sessions.
  // The census found 8 fresh sessions whose entire goal was this string.
  'Base directory for this skill:',
] as const

/**
 * Placeholder goals that import tooling emits when it cannot find a real one.
 * These are explicit "no goal" sentinels, not instructions.
 */
const PLACEHOLDER_GOALS = new Set([
  'unknown goal',
  'unknown',
  '',
])

/** Minimum length for a goal to carry any real intent. */
const MINIMUM_GOAL_LENGTH = 3

/** True if the text is transcript/runtime machinery, not a real instruction. */
export function isSystemPrompt(text: string): boolean {
  return SYSTEM_PROMPT_PREFIXES.some(prefix => text.startsWith(prefix))
}

/**
 * Strip image-attachment markers (e.g. "[Image #1]", "[Image]") so an
 * image-only message can be recognized as having no textual goal.
 */
function stripImageMarkers(text: string): string {
  return text.replace(/\[Image(?:\s*#\d+)?\]/g, '').trim()
}

/**
 * Normalize a raw prompt/goal string into a clean goal, or null if the text
 * carries no real user intent.
 *
 * Returns null when the text is:
 *   - empty / whitespace-only
 *   - a known placeholder ("unknown goal")
 *   - transcript or runtime machinery (interruption marker, skill injection)
 *   - image-only (no substantive text once image markers are removed)
 *
 * Callers should treat null as "no usable goal" — the real-time hook simply
 * skips setting a goal, and the importer flags the session unevaluable.
 */
export function sanitizeGoal(raw: string | null | undefined): string | null {
  if (raw == null) return null

  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (PLACEHOLDER_GOALS.has(trimmed.toLowerCase())) return null
  if (isSystemPrompt(trimmed)) return null

  const withoutImages = stripImageMarkers(trimmed)
  if (withoutImages.length < MINIMUM_GOAL_LENGTH) return null

  return withoutImages
}
