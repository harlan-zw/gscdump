export type R2SqlTransportRow = Record<string, unknown>
export type R2SqlTransportMetrics = Record<string, number | undefined>

export type R2SqlTransportResult
  = | {
    _tag: 'ok'
    rows: R2SqlTransportRow[]
    metrics: R2SqlTransportMetrics | null
    sql: string
    queryMs: number
  }
  | { _tag: 'timeout', timeoutMs: number }
  | {
    _tag: 'error'
    kind: 'network' | 'http' | 'rejected' | 'invalid_response'
    message: string
    status?: number
    body?: string
    retryAfterMs?: number
  }

export interface R2SqlTransportConfig {
  accountId: string
  bucket: string
  token: string
  apiBase?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  userAgent?: string
  now?: () => number
}

export interface R2SqlTransport {
  endpoint: string
  query: (sql: string) => Promise<R2SqlTransportResult>
}

interface R2SqlEnvelope {
  success?: boolean
  errors?: Array<{ message?: string }>
  result?: {
    rows?: R2SqlTransportRow[]
    columns?: string[]
    data?: unknown[][]
    metrics?: R2SqlTransportMetrics
  }
}

const DEFAULT_API_BASE = 'https://api.sql.cloudflarestorage.com/api/v1'
const DEFAULT_TIMEOUT_MS = 25_000
const MAX_RETRY_AFTER_MS = 60_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseEnvelope(body: string): R2SqlEnvelope | null {
  try {
    const value = JSON.parse(body)
    return value && typeof value === 'object' ? value as R2SqlEnvelope : null
  }
  catch {
    return null
  }
}

function normalizeRows(result: R2SqlEnvelope['result']): R2SqlTransportRow[] {
  if (Array.isArray(result?.rows))
    return result.rows
  if (!Array.isArray(result?.columns) || !Array.isArray(result.data))
    return []
  return result.data.map((tuple) => {
    const row: R2SqlTransportRow = {}
    for (let index = 0; index < result.columns!.length; index++)
      row[result.columns![index]!] = tuple[index] ?? null
    return row
  })
}

function retryAfterMs(response: Response, now: () => number): number | undefined {
  const raw = response.headers?.get?.('retry-after')
  if (!raw)
    return undefined
  const seconds = Number(raw.trim())
  const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now()
  if (!Number.isFinite(value) || value <= 0)
    return undefined
  return Math.min(value, MAX_RETRY_AFTER_MS)
}

export function createR2SqlTransport(config: R2SqlTransportConfig): R2SqlTransport {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = config.now ?? Date.now
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const endpoint = `${apiBase}/accounts/${config.accountId}/r2-sql/query/${config.bucket}`

  async function query(sql: string): Promise<R2SqlTransportResult> {
    const startedAt = now()
    const signal = AbortSignal.timeout(timeoutMs)
    const responseResult = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${config.token}`,
        'content-type': 'application/json',
        'user-agent': config.userAgent ?? 'gscdump-cloudflare-r2sql/1.0',
      },
      body: JSON.stringify({ query: sql }),
      signal,
    }).then(
      response => ({ _tag: 'ok' as const, response }),
      error => ({ _tag: 'error' as const, error }),
    )
    if (responseResult._tag === 'error') {
      if (signal.aborted || (responseResult.error as { name?: string })?.name === 'AbortError')
        return { _tag: 'timeout', timeoutMs }
      return {
        _tag: 'error',
        kind: 'network',
        message: `R2 SQL request failed: ${errorMessage(responseResult.error)}`,
      }
    }

    const { response } = responseResult
    const bodyResult = await response.text().then(
      body => ({ _tag: 'ok' as const, body }),
      error => ({ _tag: 'error' as const, error }),
    )
    if (bodyResult._tag === 'error') {
      return {
        _tag: 'error',
        kind: 'network',
        message: `R2 SQL response read failed: ${errorMessage(bodyResult.error)}`,
        status: response.status,
      }
    }
    const body = bodyResult.body
    if (!response.ok) {
      const retryAfter = retryAfterMs(response, now)
      return {
        _tag: 'error',
        kind: 'http',
        message: `R2 SQL HTTP ${response.status}: ${body}`,
        status: response.status,
        body,
        ...(retryAfter !== undefined
          ? { retryAfterMs: retryAfter }
          : {}),
      }
    }
    const envelope = parseEnvelope(body)
    if (!envelope) {
      return {
        _tag: 'error',
        kind: 'invalid_response',
        message: 'R2 SQL returned invalid JSON',
        status: response.status,
        body,
      }
    }
    if (!envelope.success) {
      const detail = envelope.errors?.map(error => error.message).filter(Boolean).join('; ') || 'unknown R2 SQL error'
      return {
        _tag: 'error',
        kind: 'rejected',
        message: `R2 SQL query rejected: ${detail}`,
        status: response.status,
        body,
      }
    }
    return {
      _tag: 'ok',
      rows: normalizeRows(envelope.result),
      metrics: envelope.result?.metrics ?? null,
      sql,
      queryMs: now() - startedAt,
    }
  }

  return { endpoint, query }
}
