/**
 * GSC API error detection and formatting utilities.
 * Provides helpful messages for quota exceeded and rate limit errors.
 */

export interface GscErrorInfo {
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

/**
 * Analyzes an error and returns structured information with suggestions.
 */
export function analyzeGscError(error: unknown): GscErrorInfo {
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

function formatQuotaSuggestion(message: string, retryAfter?: number): string {
  const lines: string[] = []

  // Detect which API quota was exceeded
  const msgLower = message.toLowerCase()
  if (msgLower.includes('indexing') || msgLower.includes('publish')) {
    lines.push(`Indexing API quota exceeded (~${GSC_QUOTAS.indexing} requests/day per property).`)
  }
  else if (msgLower.includes('inspection') || msgLower.includes('inspect')) {
    lines.push(`URL Inspection API quota exceeded (~${GSC_QUOTAS.urlInspection} requests/day per property).`)
  }
  else {
    lines.push(`Search Analytics API quota exceeded (~${GSC_QUOTAS.searchAnalytics} requests/day).`)
  }

  lines.push('')
  lines.push('Suggestions:')

  if (retryAfter) {
    lines.push(`  • Wait ${formatDuration(retryAfter)} before retrying`)
  }
  else {
    lines.push('  • Wait until quota resets (usually at midnight Pacific Time)')
  }

  lines.push('  • Use --db flag to sync data locally and query from database')
  lines.push('  • Reduce date range with -p flag (e.g., -p 30d instead of -p 180d)')
  lines.push('  • Split requests across multiple days')

  return lines.join('\n')
}

function formatRateLimitSuggestion(retryAfter?: number): string {
  const waitTime = retryAfter || 60
  const lines: string[] = []

  lines.push('Too many requests in a short period.')
  lines.push('')
  lines.push('Suggestions:')
  lines.push(`  • Wait ${formatDuration(waitTime)} before retrying`)
  lines.push('  • Increase --delay between batch operations')
  lines.push('  • Process fewer items per batch')

  return lines.join('\n')
}

function formatDuration(seconds: number): string {
  if (seconds < 60)
    return `${seconds} seconds`
  if (seconds < 3600) {
    const mins = Math.ceil(seconds / 60)
    return `${mins} minute${mins > 1 ? 's' : ''}`
  }
  const hours = Math.ceil(seconds / 3600)
  return `${hours} hour${hours > 1 ? 's' : ''}`
}

/**
 * Formats an error for CLI display with color codes.
 */
export function formatGscErrorForCli(error: unknown): string {
  const info = analyzeGscError(error)
  const lines: string[] = []

  // Error message in red
  lines.push(`\x1B[31m${info.message}\x1B[0m`)

  if (info.suggestion) {
    lines.push('')
    lines.push(info.suggestion)
  }

  return lines.join('\n')
}
