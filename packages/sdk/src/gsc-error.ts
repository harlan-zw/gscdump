// Error classification for the user-facing GSC fetch wrapper.
// Distinct from PartnerApiError (SDK partner-API errors) — this maps any
// thrown error into a structured GSC-specific status the caller renders as
// toast / banner / retry UI.

export type GscErrorStatus
  = | 'auth-missing'
    | 'rate-limited'
    | 'network'
    | 'error'

export interface GscClassifiedError {
  status: GscErrorStatus
  /** HTTP status code if the error came from a response, otherwise undefined. */
  code?: number
  /** Best-effort human message: server-supplied `message`, then `data.message`, then the error's own message. */
  message?: string
  /** Seconds the server suggested waiting (429 with `retryAfter` payload). */
  retryAfter?: number
}

export function classifyGscError(e: unknown): GscClassifiedError {
  const code = (e as { statusCode?: number, status?: number })?.statusCode
    ?? (e as { status?: number })?.status
  const message = extractMessage(e)

  if (code === 401 || code === 403)
    return { status: 'auth-missing', code, message }
  if (code === 429) {
    const retry = (e as { data?: { retryAfter?: number } })?.data?.retryAfter
    return {
      status: 'rate-limited',
      code,
      message,
      retryAfter: typeof retry === 'number' ? retry : undefined,
    }
  }
  // No code => didn't make it to the server (DNS, CORS, offline, abort).
  if (code == null && !isAbort(e))
    return { status: 'network', message }

  return { status: 'error', code, message }
}

function extractMessage(e: unknown): string | undefined {
  if (!e || typeof e !== 'object')
    return undefined
  const data = (e as { data?: unknown }).data
  if (data && typeof data === 'object') {
    const m = (data as { message?: unknown, error?: unknown }).message ?? (data as { error?: unknown }).error
    if (typeof m === 'string')
      return m
  }
  const m = (e as { message?: unknown }).message
  return typeof m === 'string' ? m : undefined
}

function isAbort(e: unknown): boolean {
  return (e as { name?: string })?.name === 'AbortError'
}
