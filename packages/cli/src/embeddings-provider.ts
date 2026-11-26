/**
 * Opt-in BYO embedding providers for building the `query_embeddings` sidecar.
 *
 * Core `gscdump` SQL analyzers remain zero-ML and never call this module.
 * Providers are explicitly selected by the user:
 * - `ollama`: local Ollama `/api/embed` endpoint (default `http://127.0.0.1:11434`, model `embeddinggemma:300m`).
 * - `workers-ai`: Cloudflare Workers AI REST API (default model `@cf/baai/bge-m3`, requires `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`).
 */

export type EmbeddingProviderKind = 'ollama' | 'workers-ai'

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderKind
  model?: string
  /** Ollama base URL (default: `OLLAMA_HOST` or `http://127.0.0.1:11434`). */
  ollamaUrl?: string
  /** Cloudflare account ID for `workers-ai` (default: `CLOUDFLARE_ACCOUNT_ID`). */
  cloudflareAccountId?: string
  /** Cloudflare API token for `workers-ai` (default: `CLOUDFLARE_API_TOKEN`). */
  cloudflareApiToken?: string
  /** Texts per HTTP batch request. Default: 64 for ollama, 100 for workers-ai. */
  batchSize?: number
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetchFn?: typeof globalThis.fetch
}

export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderKind
  readonly model: string
  readonly batchSize: number
  embedBatch: (texts: readonly string[]) => Promise<number[][]>
}

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProviderKind, string> = {
  'ollama': 'embeddinggemma:300m',
  'workers-ai': '@cf/baai/bge-m3',
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  const fetchFn = config.fetchFn ?? globalThis.fetch
  const model = config.model?.trim() || DEFAULT_EMBEDDING_MODELS[config.provider]

  if (config.provider === 'ollama') {
    const rawHost = config.ollamaUrl?.trim() || 'http://127.0.0.1:11434'
    const withScheme = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`
    const baseUrl = withScheme.replace(/\/+$/, '')
    const batchSize = config.batchSize ?? 64
    return {
      provider: 'ollama',
      model,
      batchSize,
      async embedBatch(texts) {
        if (texts.length === 0)
          return []
        const res = await fetchFn(`${baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          throw new Error(`Ollama embed failed (${res.status}) at ${baseUrl}/api/embed${detail ? `: ${detail.slice(0, 200)}` : ''}`)
        }
        const json = await res.json() as { embeddings?: unknown }
        if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length)
          throw new Error(`Ollama embed returned ${Array.isArray(json.embeddings) ? json.embeddings.length : 0} vectors for ${texts.length} inputs.`)
        return json.embeddings as number[][]
      },
    }
  }

  const accountId = config.cloudflareAccountId?.trim()
  const apiToken = config.cloudflareApiToken?.trim()
  if (!accountId || !apiToken)
    throw new Error('workers-ai provider requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or --account-id and --api-token).')

  const batchSize = config.batchSize ?? 100
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`

  return {
    provider: 'workers-ai',
    model,
    batchSize,
    async embedBatch(texts) {
      if (texts.length === 0)
        return []
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ text: texts }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Workers AI embed failed (${res.status}) for ${model}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
      }
      const json = await res.json() as { success?: boolean, result?: { data?: unknown }, errors?: Array<{ message?: string }> }
      if (json.success === false) {
        const msg = json.errors?.map(e => e.message).filter(Boolean).join('; ') || 'unknown error'
        throw new Error(`Workers AI embed error for ${model}: ${msg}`)
      }
      const data = json.result?.data
      if (!Array.isArray(data) || data.length !== texts.length)
        throw new Error(`Workers AI embed returned ${Array.isArray(data) ? data.length : 0} vectors for ${texts.length} inputs.`)
      return data as number[][]
    },
  }
}
