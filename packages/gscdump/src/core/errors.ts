// GSC API error classification + formatting.
// Classify `unknown` into a discriminated `GscError` union once, then
// downstream code switches on `kind` instead of string-matching.

export type GscErrorKind
  = | 'auth-expired'
    | 'rate-limited'
    | 'not-found'
    | 'validation'
    | 'storage'
    | 'transport'

export type GscError
  = | { kind: 'auth-expired', message: string, cause: unknown }
    | { kind: 'rate-limited', message: string, retryAfter?: number, cause: unknown }
    | { kind: 'not-found', message: string, cause: unknown }
    | { kind: 'validation', message: string, cause: unknown }
    | { kind: 'storage', message: string, cause: unknown }
    | { kind: 'transport', message: string, status?: number, cause: unknown }

/** Approximate per-day GSC API quotas, used in CLI messaging. */
export const GSC_QUOTAS = {
  searchAnalytics: 25_000,
  urlInspection: 2_000,
  indexing: 200,
} as const

/**
 * Walk `error` along each `path` (e.g. `['response', 'status']`) and return the
 * first value that satisfies `is`. Lets the field extractors share a single
 * traversal instead of hand-rolling nested optional-chain checks.
 */
function pickField<T>(
  error: unknown,
  paths: ReadonlyArray<readonly string[]>,
  is: (v: unknown) => v is T,
): T | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  for (const path of paths) {
    let current: unknown = error
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = undefined
        break
      }
      current = (current as Record<string, unknown>)[key]
    }
    if (is(current))
      return current
  }
  return undefined
}

const isNumber = (v: unknown): v is number => typeof v === 'number'
const isString = (v: unknown): v is string => typeof v === 'string'

/** Extract the HTTP status from any of the shapes we've seen in the wild. */
function extractStatus(error: unknown): number | undefined {
  return pickField(error, [['statusCode'], ['status'], ['response', 'status'], ['code']], isNumber)
}

function extractMessage(error: unknown): string {
  if (!error)
    return 'Unknown error'
  if (typeof error === 'string')
    return error
  if (error instanceof Error)
    return error.message
  if (typeof error !== 'object')
    return String(error)
  // Google API nested error takes priority — its message is more specific than the ofetch wrapper's.
  return pickField(error, [['data', 'error', 'message'], ['message'], ['statusMessage']], isString)
    ?? String(error)
}

function extractRetryAfter(error: unknown): number | undefined {
  const raw = pickField(
    error,
    [
      ['headers', 'retry-after'],
      ['headers', 'Retry-After'],
      ['response', 'headers', 'retry-after'],
      ['response', 'headers', 'Retry-After'],
    ],
    (v): v is number | string => typeof v === 'number' || typeof v === 'string',
  )
  if (typeof raw === 'number')
    return raw
  if (typeof raw === 'string') {
    const seconds = Number.parseInt(raw, 10)
    return Number.isNaN(seconds) ? undefined : seconds
  }
  return undefined
}

const QUOTA_MESSAGE_RE = /quota|rate\s*limit/i

/**
 * Classify an unknown error into a `GscError` discriminated union.
 * Transport is the catch-all — anything without a recognizable status ends up there.
 */
export function classifyError(cause: unknown): GscError {
  const status = extractStatus(cause)
  const message = extractMessage(cause)

  if (status === 401)
    return { kind: 'auth-expired', message, cause }

  if (status === 429)
    return { kind: 'rate-limited', message, retryAfter: extractRetryAfter(cause), cause }

  if (status === 403) {
    // GSC folds daily-quota exhaustion into 403. If the message mentions quota or rate limit,
    // it's a retry-later condition; otherwise it's a real permission failure.
    if (QUOTA_MESSAGE_RE.test(message))
      return { kind: 'rate-limited', message, retryAfter: extractRetryAfter(cause), cause }
    return { kind: 'auth-expired', message, cause }
  }

  if (status === 404)
    return { kind: 'not-found', message, cause }

  if (status === 400 || status === 422)
    return { kind: 'validation', message, cause }

  return { kind: 'transport', message, status, cause }
}

/** Construct a storage-kind error from inside the analytics engine / adapters. */
export function storageError(message: string, cause?: unknown): GscError {
  return { kind: 'storage', message, cause }
}

const PERMISSION_SIGNALS = [
  '403 forbidden',
  'permission_denied',
  'does not have sufficient permission',
  'insufficient permission',
]

/**
 * String-matches an error against the signals Google returns when a token
 * has lost access to a property (revoked, downgraded, or never had it).
 * Cheaper than a full {@link classifyError} call when the caller only
 * needs the permission verdict.
 */
export function isPermissionDeniedError(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '').toLowerCase()
  return PERMISSION_SIGNALS.some(s => msg.includes(s))
}

function suggestionFor(err: GscError): string {
  switch (err.kind) {
    case 'auth-expired':
      return 'Run `gscdump auth` to re-authenticate.'
    case 'rate-limited': {
      const retryIn = err.retryAfter ? `${err.retryAfter}s` : 'a few minutes'
      if (QUOTA_MESSAGE_RE.test(err.message)) {
        if (err.message.includes('Indexing API'))
          return `Indexing API quota exhausted (~${GSC_QUOTAS.indexing}/day). Try again tomorrow.`
        return `Quota or rate limit hit (Search Analytics ~${GSC_QUOTAS.searchAnalytics}/day). Try again in ${retryIn}.`
      }
      return `Rate limited. Slow down requests. Try again in ${retryIn}.`
    }
    case 'not-found':
    case 'validation':
    case 'storage':
    case 'transport':
      return ''
  }
}

/** CLI-facing formatter. Returns an ANSI-colored multi-line string. */
export function formatErrorForCli(cause: unknown): string {
  const err = classifyError(cause)
  const lines: string[] = [`\x1B[31m${err.message}\x1B[0m`]
  const suggestion = suggestionFor(err)
  if (suggestion) {
    lines.push('')
    lines.push(suggestion)
  }
  return lines.join('\n')
}
