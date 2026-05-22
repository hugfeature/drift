/**
 * Ollama Embedding Provider: uses locally-running Ollama with nomic-embed-text.
 *
 * Requirements:
 *   - Ollama installed and running (ollama serve)
 *   - nomic-embed-text model pulled (ollama pull nomic-embed-text)
 *
 * Zero cost, offline-capable, deterministic embeddings.
 * Replaces KeywordEmbeddingProvider for higher-accuracy semantic divergence.
 */

import type { EmbeddingProvider } from './provider'

export interface OllamaEmbeddingConfig {
  model?: string
  baseUrl?: string
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string
  private model: string

  constructor(config?: OllamaEmbeddingConfig) {
    this.baseUrl = config?.baseUrl
      ?? process.env.OLLAMA_BASE_URL
      ?? 'http://localhost:11434'
    this.model = config?.model
      ?? process.env.OLLAMA_EMBED_MODEL
      ?? 'nomic-embed-text'
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(
        `Ollama embed failed (${response.status}): ${errorBody}. ` +
        `Is Ollama running at ${this.baseUrl} with model "${this.model}" pulled?`
      )
    }

    const data = await response.json() as { embeddings: number[][] }

    if (!data.embeddings?.[0]) {
      throw new Error('Ollama returned empty embeddings — check model compatibility')
    }

    return data.embeddings[0]
  }
}
