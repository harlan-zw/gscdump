// The typed error (`E`) channel for the MCP handlers' own request-boundary
// failures (a bad `id`/`period`/`comparison` an agent passed), mirroring the
// repo's `kind`-discriminated convention (not `_tag`). Pairs with `Result` from
// `gscdump/result`: a `fooResult(): Result<A, McpHandlerError>` core models the
// expected failures, a thin throwing `foo()` wrapper preserves the existing
// call sites (the MCP server turns a throw into an MCP error response).
//
// This is the request-parsing boundary only. The *upstream* typed unions
// (`QueryError`, `EngineError`, `AnalysisError`) that ride up from `runReport` /
// the query builder are NOT re-modelled here; `enrichToolError` reads their
// `kind` to turn a thrown upstream failure into a richer MCP payload.

import type { AnalysisError } from '@gscdump/analysis/errors'
import type { EngineError } from '@gscdump/engine/errors'
import type { GscError } from 'gscdump/errors'
import type { QueryError } from 'gscdump/query'
import { isAnalysisError } from '@gscdump/analysis/errors'
import { isEngineError } from '@gscdump/engine/errors'
import { classifyError } from 'gscdump/errors'
import { isQueryError } from 'gscdump/query'
import { resolveBYOK, resolveServiceAccount } from '../auth'
import { resolveAuthentication } from '../auth-state'
import { HOSTED_KEY_REJECTED, HOSTED_KEY_REJECTED_REASON } from '../error-handler'
import { COMPARISON_FLAGS, PERIOD_FLAGS } from '../window'

export type McpHandlerErrorKind
  = | 'unknown-report'
    | 'unsupported-report'
    | 'unknown-period'
    | 'unknown-comparison'
    | 'no-valid-dimension'
    | 'invalid-window'

export type McpHandlerError
  = | { kind: 'unknown-report', id: string, available: readonly string[], message: string }
    | { kind: 'unsupported-report', id: string, available: readonly string[], message: string }
    | { kind: 'unknown-period', value: string, supported: readonly string[], message: string }
    | { kind: 'unknown-comparison', value: string, supported: readonly string[], message: string }
    | { kind: 'no-valid-dimension', message: string }
    | { kind: 'invalid-window', message: string }

const PERIODS = PERIOD_FLAGS
const COMPARISONS = COMPARISON_FLAGS

export const mcpHandlerErrors = {
  unknownReport(id: string, available: readonly string[]): McpHandlerError {
    return { kind: 'unknown-report', id, available, message: `Unknown report id "${id}". Available: ${available.join(', ')}` }
  },
  unsupportedReport(id: string, available: readonly string[]): McpHandlerError {
    return { kind: 'unsupported-report', id, available, message: `Report "${id}" cannot run through the live MCP Source. Use the CLI with the local Store.` }
  },
  unknownPeriod(value: string): McpHandlerError {
    return { kind: 'unknown-period', value, supported: PERIODS, message: `Unknown period "${value}". Supported: ${PERIODS.join(', ')}.` }
  },
  unknownComparison(value: string): McpHandlerError {
    return { kind: 'unknown-comparison', value, supported: COMPARISONS, message: `Unknown comparison "${value}". Supported: ${COMPARISONS.join(', ')}.` }
  },
  invalidWindow(message: string): McpHandlerError {
    return { kind: 'invalid-window', message }
  },
  noValidDimension(): McpHandlerError {
    return { kind: 'no-valid-dimension', message: 'At least one valid dimension required' }
  },
} as const

/**
 * Re-raise an `McpHandlerError` as a plain `Error`, stashing the union under
 * `.mcpHandlerError` and keeping `.message` verbatim so the MCP server's error
 * response (and any message-regex assertions) stay unchanged.
 */
export function mcpHandlerErrorToException(error: McpHandlerError): Error {
  const exception = new Error(error.message)
  ;(exception as Error & { mcpHandlerError?: McpHandlerError }).mcpHandlerError = error
  return exception
}

/**
 * Turn an upstream typed failure thrown out of a tool body (`runReport`, the
 * query builder, the engine) into a richer MCP-facing `Error` message that names
 * the modelled `kind` and an actionable next step, instead of leaking the bare
 * message the SDK would otherwise relay. Returns `null` when the error is not a
 * modelled upstream union (a defect — let the server relay it untouched).
 */
export function enrichToolError(error: unknown): Error | null {
  const query = asQueryError(error)
  if (query)
    return new Error(`[query:${query.kind}] ${query.message}`)

  const analysis = asAnalysisError(error)
  if (analysis) {
    // A required-step failure usually wraps an engine failure; name both.
    const cause = analysis.kind === 'required-step-failed' ? asEngineError(analysis.cause) : null
    const tail = cause ? ` (engine:${cause.kind})` : ''
    return new Error(`[analysis:${analysis.kind}]${tail} ${analysis.message}`)
  }

  const engine = asEngineError(error)
  if (engine)
    return new Error(`[engine:${engine.kind}] ${engine.message}`)

  return null
}

function asQueryError(error: unknown): QueryError | null {
  if (isQueryError(error))
    return error
  const tagged = (error as { queryError?: unknown })?.queryError
  return isQueryError(tagged) ? tagged : null
}

function asEngineError(error: unknown): EngineError | null {
  if (isEngineError(error))
    return error
  const tagged = (error as { engineError?: unknown })?.engineError
  return isEngineError(tagged) ? tagged : null
}

function asAnalysisError(error: unknown): AnalysisError | null {
  if (isAnalysisError(error))
    return error
  const tagged = (error as { analysisError?: unknown })?.analysisError
  return isAnalysisError(tagged) ? tagged : null
}

function httpStatus(error: unknown): number | undefined {
  const value = error as { statusCode?: unknown, status?: unknown, response?: { status?: unknown } } | null
  const status = value?.statusCode ?? value?.status ?? value?.response?.status
  return typeof status === 'number' ? status : undefined
}

/** The authentication mode the failing call ran in; it decides the next step. */
export type ApiErrorMode = 'cloud' | 'local' | 'byok' | 'service-account'

/**
 * The active authentication mode for error advice. Falls back to `local` when
 * the mode cannot be resolved, keeping the long-standing local advice. The
 * order mirrors `resolveAuth`: service account first, then BYOK env vars, so
 * the advice names the credential the failing call actually used instead of
 * one `resolveAuth` would keep outranking.
 */
async function authenticationMode(): Promise<ApiErrorMode> {
  const state = await resolveAuthentication().catch(() => null)
  if (state?._tag === 'Cloud')
    return 'cloud'
  // A stale pointer (missing or malformed key file) is ignorable here: it
  // falls through to BYOK and saved tokens, exactly like `resolveAuth`.
  const serviceAccount = await resolveServiceAccount().then(Boolean).catch(() => null)
  if (serviceAccount)
    return 'service-account'
  // A throw here only means no runtime context; fall back to the local advice.
  const byok = await Promise.resolve().then(() => resolveBYOK()).catch(() => null)
  return byok ? 'byok' : 'local'
}

/** Google OAuth grant failures that no `auth login`-unaware advice may miss. */
const OAUTH_TOKEN_FAILURE_RE = /invalid_grant|invalid_client|unauthorized_client|token has been expired|token has been revoked/i

/**
 * A rejected OAuth grant surfaces as a 400 from the token endpoint, not a 401,
 * so `classifyError` files it under `validation`. Reclassify the grant signals
 * as auth-expired; argument advice stays for real Google API 400s.
 */
function classifyGoogleError(error: unknown): GscError {
  const classified = classifyError(error)
  if (classified.kind !== 'validation')
    return classified
  const text = `${classified.message} ${googleMessage(error) ?? ''}`
  return OAUTH_TOKEN_FAILURE_RE.test(text) ? { ...classified, kind: 'auth-expired' } : classified
}

function nextStep(error: GscError, status: number, mode: ApiErrorMode): string {
  if (error.kind === 'rate-limited')
    return `Google quota or rate limit reached. Try again in ${error.retryAfter ? `${error.retryAfter}s` : 'a few minutes'}.`
  if (status === 403) {
    if (mode === 'cloud')
      return 'The gscdump.com account cannot open this Site. Check the Site is connected to your account at gscdump.com.'
    return 'The signed-in account cannot open this Site. Check its Search Console permissions, or run `gscdump auth status` to see the account.'
  }
  if (status === 401 || error.kind === 'auth-expired') {
    if (mode === 'cloud')
      return 'Set or refresh GSCDUMP_API_KEY to a user API key from your gscdump.com settings.'
    if (mode === 'service-account')
      return 'Fix the service-account key (GSC_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS) in the MCP server configuration and restart the MCP client, or run `gscdump auth status`.'
    if (mode === 'byok')
      return 'Refresh GSC_ACCESS_TOKEN (or GSC_CLIENT_ID, GSC_CLIENT_SECRET, and GSC_REFRESH_TOKEN) in the MCP server configuration and restart the MCP client.'
    return 'Run `gscdump auth login` in a terminal to connect again.'
  }
  if (error.kind === 'not-found')
    return 'Check the Site and URL. Call list-sites to see the Sites of this account.'
  if (error.kind === 'validation')
    return 'Check the tool arguments.'
  return status >= 500 ? 'Try again later.' : ''
}

/**
 * One line for a failed Google or hosted API call: the status, Google's own
 * explanation, and the next step. Returns `null` for an error with no HTTP
 * status, so the caller keeps its message.
 */
export function describeApiError(error: unknown, mode: ApiErrorMode = 'local'): string | null {
  const status = httpStatus(error)
  if (status === undefined)
    return null
  const classified = classifyGoogleError(error)
  const message = googleMessage(error) ?? classified.message
  // The CLI's hosted key message ends in a terminal command; nextStep gives the MCP fix instead.
  const reason = (message === HOSTED_KEY_REJECTED ? HOSTED_KEY_REJECTED_REASON : message).replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  return `API error ${status}: ${reason}. ${nextStep(classified, status, mode)}`.trim()
}

/** Google's own explanation beats the fetch wrapper text (`[GET] url: 403`). */
function googleMessage(error: unknown): string | undefined {
  // ofetch wraps the body in `.data`; gaxios (google-auth-library) in `.response.data`.
  const bodies = [
    (error as { data?: unknown } | null)?.data,
    (error as { response?: { data?: unknown } } | null)?.response?.data,
  ]
  for (const body of bodies) {
    const data = body as { error?: unknown, error_description?: unknown } | undefined
    const nested = (data?.error as { message?: unknown } | undefined)?.message
    const message = typeof nested === 'string' ? nested : data?.error_description
    if (typeof message === 'string' && message)
      return message
  }
  return undefined
}

/** The text an agent sees when a tool fails. */
export async function toolErrorMessage(error: unknown): Promise<string> {
  const mode = await authenticationMode()
  return enrichToolError(error)?.message
    ?? describeApiError(error, mode)
    ?? (error instanceof Error ? error.message : String(error))
}
