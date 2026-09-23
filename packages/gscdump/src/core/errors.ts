// GSC API error classification + formatting.
// Classify `unknown` into a discriminated `GscError` union once, then
// downstream code switches on `kind` instead of string-matching.

export type GscErrorKind
  = | 'auth-expired'
    | 'permission-denied'
    | 'rate-limited'
    | 'not-found'
    | 'validation'
    | 'storage'
    | 'transport'

export type GscError
  = | { kind: 'auth-expired', message: string, cause: unknown }
    | { kind: 'permission-denied', message: string, cause: unknown }
    | { kind: 'rate-limited', message: string, retryAfter?: number, cause: unknown }
    | { kind: 'not-found', message: string, cause: unknown }
    | { kind: 'validation', message: string, cause: unknown }
    | { kind: 'storage', message: string, cause: unknown }
    | { kind: 'transport', message: string, status?: number, cause: unknown }

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
  if (typeof error !== 'object')
    return String(error)
  // Google's own reason beats the ofetch wrapper text ("[POST] url: 403"),
  // including when the wrapper is an Error (ofetch's FetchError is one).
  return pickField(error, [['data', 'error', 'message'], ['data', 'error_description'], ['message'], ['statusMessage']], isString)
    ?? String(error)
}

function extractRetryAfter(error: unknown): number | undefined {
  const headers = pickField(error, [['headers'], ['response', 'headers']], (value): value is Headers => value instanceof Headers)
  const raw = pickField(
    error,
    [
      ['headers', 'retry-after'],
      ['headers', 'Retry-After'],
      ['response', 'headers', 'retry-after'],
      ['response', 'headers', 'Retry-After'],
    ],
    (v): v is number | string => typeof v === 'number' || typeof v === 'string',
  ) ?? headers?.get('retry-after')
  if (typeof raw === 'number')
    return raw
  if (typeof raw === 'string') {
    const seconds = Number.parseInt(raw, 10)
    return Number.isNaN(seconds) ? undefined : seconds
  }
  return undefined
}

// Google words load-quota 403s as "quota exceeded" and per-second limits as "QPS".
const QUOTA_MESSAGE_RE = /quota|rate\s*limit|\bqps\b/i

/** GSC/Google API `reason` codes that indicate quota/rate exhaustion (not a real permission failure). */
const QUOTA_REASONS = new Set([
  'dailyLimitExceeded',
  'dailyLimitExceededUnreg',
  'rateLimitExceeded',
  'rateLimitExceededUnreg',
  'userRateLimitExceeded',
  'userRateLimitExceededUnreg',
  'quotaExceeded',
  'concurrentLimitExceeded',
  'variableTermLimitExceeded',
  'variableTermExpiredDailyExceeded',
  'servingLimitExceeded',
  'responseTooLarge',
  'limitExceeded',
  'batchSizeTooLarge',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
])

function extractReason(cause: unknown): string | undefined {
  // ofetch FetchError wraps Google's JSON body in `data`; check there first, then the parsed details path.
  const data = pickField(cause, [['data']], (_v): _v is unknown => true)
  if (data) {
    const errorInfo = pickField(
      data,
      [['error', 'details']],
      (v): v is Array<Record<string, unknown>> => Array.isArray(v),
    )
    if (errorInfo) {
      const info = errorInfo.find(d => typeof d['@type'] === 'string' && d['@type'].includes('ErrorInfo'))
      const reason = info?.reason
      if (typeof reason === 'string')
        return reason
    }
    const directErrors = pickField(
      data,
      [['error', 'errors']],
      (v): v is Array<Record<string, unknown>> => Array.isArray(v),
    )
    if (directErrors) {
      const reason = directErrors[0]?.reason
      if (typeof reason === 'string')
        return reason
    }
  }
  return undefined
}

function isQuotaCondition(cause: unknown, message: string): boolean {
  const reason = extractReason(cause)
  if (reason && QUOTA_REASONS.has(reason))
    return true
  return QUOTA_MESSAGE_RE.test(message)
}

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
    // GSC folds daily-quota exhaustion into 403. Prefer the structured `reason` from the
    // Google error envelope; fall back to message substring for older/unknown shapes.
    if (isQuotaCondition(cause, message))
      return { kind: 'rate-limited', message, retryAfter: extractRetryAfter(cause), cause }
    // A 403 means the credentials work but lack access. Signing in again
    // does not fix it, so it is not `auth-expired`.
    return { kind: 'permission-denied', message, cause }
  }

  if (status === 404 || status === 410)
    return { kind: 'not-found', message, cause }

  // 400 invalid argument, 402 billing required, 409 conflict (e.g. sites.add
  // duplicate), 413 batch too large, 422 unprocessable — all classify as
  // caller-fixable validation problems.
  if (status === 400 || status === 402 || status === 409 || status === 413 || status === 422)
    return { kind: 'validation', message, cause }

  return { kind: 'transport', message, status, cause }
}

/**
 * Re-raises a `GscError` value as an `Error`, preserving its `cause` for
 * stack-walking and stashing the original union under `.gscError`. Pairs with
 * `unwrapResult` from `gscdump/result` so a `fooResult(): Result<A, GscError>`
 * core can be wrapped by a throwing `foo()` without losing the typed error.
 */
export function gscErrorToException(error: GscError): Error {
  const exception = new Error(error.message)
  if (error.cause !== undefined)
    (exception as Error & { cause?: unknown }).cause = error.cause
  ;(exception as Error & { gscError?: GscError }).gscError = error
  return exception
}

// --- Structured Google API error (parsed JSON shape) -----------------------
// Complements `classifyError` (which routes any unknown into the `GscError`
// union). `parseGoogleError` is the parsing layer: it pulls the canonical
// `{code, message, reason, status}` info out of Google's error JSON shape
// (both the nested `errors.googleapis.com`-style envelope and the bare OAuth
// `{error, error_description}` shape). `GscApiError` carries that info.

interface GoogleApiErrorNested {
  error: {
    code: number
    message: string
    status?: string
    details?: Array<{
      '@type': string
      'reason'?: string
      'domain'?: string
      'metadata'?: Record<string, string>
    }>
  }
}

interface GoogleOAuthError {
  error: string
  error_description?: string
  error_uri?: string
}

export interface GscApiErrorInfo {
  code: number
  message: string
  reason?: string
  status?: string
}

export function parseGoogleError(text: string, httpStatus?: number): GscApiErrorInfo {
  let parsed: GoogleApiErrorNested | GoogleOAuthError | null = null
  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    // A non-JSON response body is a valid transport error payload. JSON.parse
    // only throws SyntaxError, but retain the guard so unexpected failures are
    // not converted into a generic API error.
    if (!(error instanceof SyntaxError))
      throw error
  }

  if (!parsed || !('error' in parsed))
    return { code: httpStatus ?? 500, message: text || 'Unknown Google API error' }

  if (typeof parsed.error === 'string') {
    const oauth = parsed as GoogleOAuthError
    return {
      code: httpStatus ?? 400,
      message: oauth.error_description || oauth.error,
      reason: oauth.error,
    }
  }

  const err = (parsed as GoogleApiErrorNested).error
  const errorInfo = err.details?.find(d => d['@type']?.includes('ErrorInfo'))
  return {
    code: err.code ?? httpStatus ?? 500,
    message: err.message || err.status || text || `HTTP ${httpStatus ?? '?'}`,
    reason: errorInfo?.reason,
    status: err.status,
  }
}

export class GscApiError extends Error {
  constructor(message: string, public info: GscApiErrorInfo) {
    super(message)
    this.name = 'GscApiError'
  }
}

/**
 * Returns a handler that re-throws `unknown` as a `GscApiError` prefixed with
 * `prefix`. Recognises `ofetch` `FetchError` (parses `err.data` as Google JSON
 * via `parseGoogleError`); passes through existing `GscApiError`; re-throws
 * anything else as-is.
 */
export function rethrowAsGscApiError(prefix: string): (err: unknown) => never {
  return (err: unknown) => {
    if (err instanceof GscApiError)
      throw err
    // ofetch FetchError has shape { statusCode, data, message }
    const maybe = err as { name?: string, statusCode?: number, data?: unknown }
    if (maybe && maybe.name === 'FetchError') {
      const text = typeof maybe.data === 'string' ? maybe.data : JSON.stringify(maybe.data ?? {})
      const info = parseGoogleError(text, maybe.statusCode)
      throw new GscApiError(`${prefix}: ${info.message}`, info)
    }
    throw err
  }
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
