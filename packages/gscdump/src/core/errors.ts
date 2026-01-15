/**
 * GSC API error detection and formatting utilities.
 * Provides helpful messages for quota exceeded and rate limit errors.
 */

export interface ErrorInfo {
  isQuotaError: boolean
  isRateLimitError: boolean
  isAuthError: boolean
  code?: number
  message: string
  retryAfter?: number
  suggestion: string
}

/** GSC API quota limits (approximate) */
export const GSC_QUOTAS = {
  /** Search Analytics API: ~25,000 requests/day per project */
  searchAnalytics: 25_000,
  /** URL Inspection API: ~2,000 requests/day per property */
  urlInspection: 2_000,
  /** Indexing API: ~200 requests/day per property */
  indexing: 200,
} as const

/**
 * Detects if an error is a quota exceeded error (403 quotaExceeded).
 */
export function isQuotaError(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase()
  const code = getErrorCode(error)
  return code === 403 && (
    msg.includes('quota')
    || msg.includes('limit exceeded')
    || msg.includes('rate limit')
    || msg.includes('quotaexceeded')
  )
}

/**
 * Detects if an error is a rate limit error (429 Too Many Requests).
 */
export function isRateLimitError(error: unknown): boolean {
  const code = getErrorCode(error)
  return code === 429
}

/**
 * Detects if an error is an authentication error (401/403 without quota).
 */
export function isAuthError(error: unknown): boolean {
  const code = getErrorCode(error)
  const msg = getErrorMessage(error).toLowerCase()
  if (code === 401)
    return true
  if (code === 403 && !isQuotaError(error))
    return msg.includes('access') || msg.includes('permission') || msg.includes('forbidden')
  return false
}

/**
 * Extracts HTTP status code from various error formats.
 */
export function getErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  const e = error as Record<string, unknown>
  // ofetch error format
  if ('statusCode' in e && typeof e.statusCode === 'number')
    return e.statusCode
  // Standard response format
  if ('status' in e && typeof e.status === 'number')
    return e.status
  // Nested response
  if ('response' in e && e.response && typeof e.response === 'object') {
    const resp = e.response as Record<string, unknown>
    if ('status' in resp && typeof resp.status === 'number')
      return resp.status
  }
  // Google API error format
  if ('code' in e && typeof e.code === 'number')
    return e.code
  return undefined
}

/**
 * Extracts error message from various error formats.
 */
export function getErrorMessage(error: unknown): string {
  if (!error)
    return 'Unknown error'
  if (typeof error === 'string')
    return error
  if (error instanceof Error)
    return error.message
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>
    if ('message' in e && typeof e.message === 'string')
      return e.message
    if ('statusMessage' in e && typeof e.statusMessage === 'string')
      return e.statusMessage
    // Google API nested error
    if ('data' in e && e.data && typeof e.data === 'object') {
      const data = e.data as Record<string, unknown>
      if ('error' in data && data.error && typeof data.error === 'object') {
        const err = data.error as Record<string, unknown>
        if ('message' in err && typeof err.message === 'string')
          return err.message
      }
    }
  }
  return String(error)
}

/**
 * Extracts retry-after value from error headers (in seconds).
 */
export function getRetryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  const e = error as Record<string, unknown>
  // Check headers
  if ('headers' in e && e.headers && typeof e.headers === 'object') {
    const headers = e.headers as Record<string, unknown>
    const retryAfter = headers['retry-after'] || headers['Retry-After']
    if (typeof retryAfter === 'string') {
      const seconds = Number.parseInt(retryAfter, 10)
      return Number.isNaN(seconds) ? undefined : seconds
    }
    if (typeof retryAfter === 'number')
      return retryAfter
  }
  return undefined
}

function formatQuotaSuggestion(message: string, retryAfter?: number): string {
  if (message.includes('Search Console API'))
    return `You exceeded the Search Analytics quota (${GSC_QUOTAS.searchAnalytics}/day). Try again tomorrow.`
  if (message.includes('Indexing API'))
    return `You exceeded the Indexing API quota (${GSC_QUOTAS.indexing}/day). Try again tomorrow.`
  return `Quota exceeded. Try again in ${retryAfter ? `${retryAfter}s` : '24 hours'}.`
}

function formatRateLimitSuggestion(retryAfter?: number): string {
  return `Rate limited. Slow down requests. Try again in ${retryAfter ? `${retryAfter}s` : 'a few minutes'}.`
}

/**
 * Analyzes an error and returns structured information with suggestions.
 */
export function analyzeError(error: unknown): ErrorInfo {
  const code = getErrorCode(error)
  const message = getErrorMessage(error)
  const retryAfter = getRetryAfter(error)

  if (isQuotaError(error)) {
    return {
      isQuotaError: true,
      isRateLimitError: false,
      isAuthError: false,
      code,
      message,
      retryAfter,
      suggestion: formatQuotaSuggestion(message, retryAfter),
    }
  }

  if (isRateLimitError(error)) {
    return {
      isQuotaError: false,
      isRateLimitError: true,
      isAuthError: false,
      code,
      message,
      retryAfter: retryAfter || 60,
      suggestion: formatRateLimitSuggestion(retryAfter),
    }
  }

  if (isAuthError(error)) {
    return {
      isQuotaError: false,
      isRateLimitError: false,
      isAuthError: true,
      code,
      message,
      suggestion: 'Run `gscdump auth` to re-authenticate.',
    }
  }

  return {
    isQuotaError: false,
    isRateLimitError: false,
    isAuthError: false,
    code,
    message,
    suggestion: '',
  }
}

/**
 * Formats an error for CLI display with color codes.
 */
export function formatErrorForCli(error: unknown): string {
  const info = analyzeError(error)
  const lines: string[] = []

  // Error message in red
  lines.push(`\x1B[31m${info.message}\x1B[0m`)

  if (info.suggestion) {
    lines.push('')
    lines.push(info.suggestion)
  }

  return lines.join('\n')
}