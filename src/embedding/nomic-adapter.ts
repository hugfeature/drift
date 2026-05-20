/**
 * Nomic Embed adapter for production-grade semantic similarity.
 *
 * Uses nomic-embed-text (via Ollama local or nomic API) for real embeddings.
 * Falls back to KeywordEmbeddingProvider if unavailable.
 *
 * Environment variables:
 *   DRIFT_EMBEDDING_PROVIDER  = "nomic" | "openai" | "keyword" (default: "keyword")
 *   DRIFT_EMBEDDING_BASE_URL  = Ollama or API base URL (default: "http://localhost:11434")
 *   DRIFT_EMBEDDING_MODEL     = Model name (default: "nomic-embed-text")
 *   DRIFT_EMBEDDING_API_KEY   = API key for remote providers (optional for Ollama)
 */

import type { EmbeddingProvider } from './provider'

export interface EmbeddingConfig {
  provider: 'nomic' | 'openai' | 'keyword'
  baseUrl: string
  model: string
  apiKey?: string
  dimensions?: number
}

function loadConfigFromEnv(): EmbeddingConfig {
  return {
    provider: (process.env.DRIFT_EMBEDDING_PROVIDER as EmbeddingConfig['provider']) || 'keyword',
    baseUrl: process.env.DRIFT_EMBEDDING_BASE_URL || 'http://localhost:11434',
    model: process.env.DRIFT_EMBEDDING_MODEL || 'nomic-embed-text',
    apiKey: process.env.DRIFT_EMBEDDING_API_KEY,
    dimensions: process.env.DRIFT_EMBEDDING_DIMENSIONS
      ? parseInt(process.env.DRIFT_EMBEDDING_DIMENSIONS, 10)
      : undefined,
  }
}

/**
 * NomicEmbeddingProvider — calls Ollama-compatible /api/embeddings endpoint.
 * Works with local Ollama or any OpenAI-compatible embedding API.
 */
export class NomicEmbeddingProvider implements EmbeddingProvider {
  private config: EmbeddingConfig
  private cache: Map<string, number[]> = new Map()

  constructor(config?: Partial<EmbeddingConfig>) {
    this.config = { ...loadConfigFromEnv(), ...config }
  }

  async embed(text: string): Promise<number[]> {
    const cacheKey = text.slice(0, 300)
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!
    }

    const vector = this.config.provider === 'openai'
      ? await this.embedViaOpenAI(text)
      : await this.embedViaOllama(text)

    this.cache.set(cacheKey, vector)
    return vector
  }

  private async embedViaOllama(text: string): Promise<number[]> {
    const url = `${this.config.baseUrl}/api/embeddings`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        prompt: text,
      }),
    })

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as { embedding: number[] }
    return data.embedding
  }

  private async embedViaOpenAI(text: string): Promise<number[]> {
    const url = `${this.config.baseUrl}/v1/embeddings`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      input: text,
    }
    if (this.config.dimensions) {
      body['dimensions'] = this.config.dimensions
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    return data.data[0].embedding
  }
}

/**
 * Factory: create the appropriate embedding provider based on config.
 * Defaults to keyword provider (zero dependencies, deterministic).
 */
export async function createEmbeddingProvider(
  config?: Partial<EmbeddingConfig>
): Promise<EmbeddingProvider> {
  const resolved = { ...loadConfigFromEnv(), ...config }

  if (resolved.provider === 'keyword') {
    const { KeywordEmbeddingProvider } = await import('./provider')
    return new KeywordEmbeddingProvider()
  }

  // Verify connectivity before returning real provider
  const provider = new NomicEmbeddingProvider(resolved)
  try {
    await provider.embed('connection test')
    return provider
  } catch (error) {
    console.warn(
      `[drift] Failed to connect to ${resolved.provider} embedding service at ${resolved.baseUrl}. ` +
      `Falling back to keyword provider. Error: ${(error as Error).message}`
    )
    const { KeywordEmbeddingProvider } = await import('./provider')
    return new KeywordEmbeddingProvider()
  }
}
