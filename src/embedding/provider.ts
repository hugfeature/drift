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
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
}

/**
 * KeywordEmbeddingProvider
 *
 * Builds a sparse vector over a shared vocabulary.
 * Cheap, deterministic, zero network calls.
 *
 * Good enough for v0 drift detection.
 * Replace with a real model when eval shows it's not sufficient.
 */
export class KeywordEmbeddingProvider implements EmbeddingProvider {
  private vocab: Map<string, number> = new Map()
  private vocabSize = 0

  private getOrAddTerm(term: string): number {
    if (!this.vocab.has(term)) {
      this.vocab.set(term, this.vocabSize++)
    }
    return this.vocab.get(term)!
  }

  async embed(text: string): Promise<number[]> {
    const tokens = tokenize(text)
    if (tokens.length === 0) return []

    // Register all terms first so we know final vocab size
    tokens.forEach(t => this.getOrAddTerm(t))

    const vec = new Array<number>(this.vocabSize).fill(0)
    for (const token of tokens) {
      vec[this.vocab.get(token)!] += 1
    }

    // L2-normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    return norm === 0 ? vec : vec.map(v => v / norm)
  }

  /**
   * Vocabulary size grows as new terms are seen.
   * Vectors from earlier calls may be shorter — pad before comparing.
   */
  padToSameLength(a: number[], b: number[]): [number[], number[]] {
    const len = Math.max(a.length, b.length)
    const pad = (v: number[]) => [...v, ...new Array(len - v.length).fill(0)]
    return [pad(a), pad(b)]
  }
}
