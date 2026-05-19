/**
 * Embedding abstraction layer.
 *
 * Drift needs semantic similarity to detect goal divergence.
 * This module provides a pluggable interface so the embedding
 * backend can be swapped without touching the scorer.
 *
 * v0 strategy: keyword-overlap similarity (zero dependencies).
 * Swap to nomic-embed-text or text-embedding-3-small for better accuracy.
 *
 * Why not OpenAI by default:
 *   - offline sessions would fail
 *   - benchmark results would be non-reproducible
 *   - cost would discourage contributors
 *
 * The EmbeddingProvider interface is the contract.
 * Any implementation that satisfies it works.
 */

export interface EmbeddingProvider {
  /**
   * Embed a text string into a numeric vector.
   * Vectors from the same provider are comparable via cosine similarity.
   */
  embed(text: string): Promise<number[]>
}

/**
 * Cosine similarity between two vectors.
 * Returns 0.0 (orthogonal/unrelated) to 1.0 (identical).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Semantic divergence: 1.0 - cosine similarity.
 * 0.0 = perfectly aligned, 1.0 = completely unrelated.
 */
export function semanticDivergence(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b)
}

// ---------------------------------------------------------------------------
// v0: Keyword overlap provider (no dependencies)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','to','of','in','on','at','by','for',
  'with','from','and','or','but','not','this','that','it','its',
  'usr','bin','users','home','node_modules','dist','build',
  'true','false','null','undefined','function','return','const',
  'let','var','import','export','require','module',
])

/**
 * Split camelCase and PascalCase into separate words.
 * e.g. "registerPage" → ["register", "page"]
 */
function splitCamelCase(word: string): string[] {
  return word
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
}

/**
 * Extract meaningful tokens from file paths.
 * e.g. "/Users/x/project/preview/pages.js" → ["preview", "pages"]
 */
function tokenizePath(filepath: string): string[] {
  const segments = filepath.split(/[/\\]/).filter(Boolean)
  // Take last 3 meaningful path segments (skip home/user dirs)
  const meaningful = segments.slice(-3)
  const tokens: string[] = []
  for (const seg of meaningful) {
    // Remove file extension
    const name = seg.replace(/\.[^.]+$/, '')
    // Split by hyphens, underscores, dots
    const parts = name.split(/[-_.]+/)
    for (const part of parts) {
      tokens.push(...splitCamelCase(part))
    }
  }
  return tokens.filter(t => t.length > 1)
}

function tokenize(text: string): string[] {
  const tokens: string[] = []

  // Detect and extract file paths
  const pathPattern = /(?:\/[\w.-]+){2,}/g
  const paths = text.match(pathPattern) || []
  for (const p of paths) {
    tokens.push(...tokenizePath(p))
  }

  // Remove paths from text before normal tokenization
  const textWithoutPaths = text.replace(pathPattern, ' ')

  // Split by non-alphanumeric, underscores, hyphens
  const rawWords = textWithoutPaths
    .replace(/[^a-zA-Z0-9\s_-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(w => w.length > 1)

  for (const word of rawWords) {
    // Split camelCase
    tokens.push(...splitCamelCase(word))
  }

  // Deduplicate and filter
  const seen = new Set<string>()
  return tokens
    .map(t => t.toLowerCase())
    .filter(t => t.length > 1 && !STOPWORDS.has(t) && !seen.has(t) && (seen.add(t), true))
}

/**
 * KeywordEmbeddingProvider
 *
 * Uses token-set based similarity instead of sparse cosine vectors.
 * This avoids the "vocabulary dilution" problem where cosine similarity
 * drops as more unique terms are seen across different embeddings.
 *
 * Similarity = weighted blend of:
 *   - Goal-term recall: what fraction of goal tokens appear in the action?
 *   - Jaccard overlap: |intersection| / |union|
 *
 * Cheap, deterministic, zero network calls.
 * Replace with a real model when eval shows it's not sufficient.
 */
export class KeywordEmbeddingProvider implements EmbeddingProvider {
  // Embed returns the token set encoded as a simple array.
  // The actual similarity is computed via tokenSimilarity, not cosine.
  private tokenCache: Map<string, Set<string>> = new Map()

  async embed(text: string): Promise<number[]> {
    const tokens = tokenize(text)
    // Store token set for later retrieval
    const key = text.slice(0, 200)
    this.tokenCache.set(key, new Set(tokens))
    // Return a dummy vector — actual comparison uses tokenSimilarity
    return tokens.map((_, i) => i)
  }

  /**
   * Compute semantic similarity between goal text and action text.
   * Returns 0.0 (completely unrelated) to 1.0 (identical).
   *
   * Strategy:
   *   1. Domain hit detection — if any goal keyword (4+ chars) appears as substring
   *      in the action text, it's a domain match. Even one hit means the action is
   *      at least tangentially related.
   *   2. Graduated scoring based on number of hits:
   *      - 0 hits → pure unrelated (score 0)
   *      - 1 hit  → minimum "expansion" level (0.3)
   *      - 2 hits → "refinement" level (0.5)
   *      - 3+ hits → "aligned" level (0.7+)
   *
   * This approach works because in real sessions, an action touching /preview/pages.js
   * when the goal mentions "preview" and "pages" is clearly aligned — even if the
   * action also contains many unrelated tokens (grep flags, full paths, etc).
   */
  tokenSimilarity(goalText: string, actionText: string): number {
    const goalTokens = tokenize(goalText)
    const actionTokens = new Set(tokenize(actionText))
    const actionLower = actionText.toLowerCase()

    if (goalTokens.length === 0 || actionTokens.size === 0) return 0

    // Count domain hits: goal tokens found in action (exact token match OR substring)
    let hits = 0
    const goalTokenSet = new Set(goalTokens)
    const counted = new Set<string>()

    for (const token of goalTokenSet) {
      if (counted.has(token)) continue
      counted.add(token)

      // Exact token match
      if (actionTokens.has(token)) {
        hits++
        continue
      }
      // Substring match for tokens 4+ chars (avoids noise from short words)
      if (token.length >= 4 && actionLower.includes(token)) {
        hits++
      }
    }

    // Graduated scoring based on hit count
    if (hits === 0) return 0
    if (hits === 1) return 0.35
    if (hits === 2) return 0.55
    if (hits === 3) return 0.70
    return Math.min(0.70 + (hits - 3) * 0.05, 0.95)
  }

  /**
   * Kept for API compatibility. With token-set approach, padding is unnecessary
   * but we maintain the interface contract.
   */
  padToSameLength(a: number[], b: number[]): [number[], number[]] {
    const len = Math.max(a.length, b.length)
    const pad = (v: number[]) => [...v, ...new Array(len - v.length).fill(0)]
    return [pad(a), pad(b)]
  }
}