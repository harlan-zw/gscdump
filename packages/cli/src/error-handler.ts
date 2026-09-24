import type { AnalysisError } from '@gscdump/analysis/errors'
import type { EngineError } from '@gscdump/engine/errors'
import type { GscError } from 'gscdump/errors'
import type { QueryError } from 'gscdump/query'
import { isAnalysisError } from '@gscdump/analysis/errors'
import { isEngineError } from '@gscdump/engine/errors'
import { classifyError } from 'gscdump/errors'
import { isQueryError } from 'gscdump/query'
import { isUsageError } from './command-registry'

/** A hosted 401: the gscdump.com API key failed, not a Google credential. */
export const HOSTED_KEY_REJECTED_REASON = 'gscdump.com rejected the API key'
export const HOSTED_KEY_REJECTED = `${HOSTED_KEY_REJECTED_REASON}. Run \`gscdump auth login --mode cloud --api-key KEY\` with a valid key.`

const QUOTA_MESSAGE_RE = /quota|rate\s*limit/i
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g

/** Next step for a classified Google API failure, or '' when the message says enough. */
function suggestionForGscError(error: GscError): string {
  switch (error.kind) {
    case 'auth-expired':
      return 'Run `gscdump auth login` to sign in again.'
    case 'permission-denied':
      return 'Check that this Google account is a full user or owner of the Site. Run `gscdump sites` to see your Sites.'
    case 'rate-limited': {
      const retryIn = error.retryAfter ? `${error.retryAfter}s` : 'a few minutes'
      if (!QUOTA_MESSAGE_RE.test(error.message))
        return `Google rate limited the request. Try again in ${retryIn}.`
      return error.message.includes('Indexing API')
        ? 'The Indexing API quota is used up (about 200 per day). Try again tomorrow.'
        : `A Google quota or rate limit was reached. Try again in ${retryIn}.`
    }
    case 'not-found':
    case 'validation':
    case 'storage':
    case 'transport':
      return ''
  }
}

/**
 * The errors-as-values refactor in `gscdump`/`@gscdump/engine`/`@gscdump/analysis`
 * stashes the typed union on the thrown `Error` under a per-package key
 * (`.queryError` / `.engineError` / `.analysisError`) when a `*Result` core is
 * collapsed back to a throw. The CLI is the end consumer: it reads those typed
 * `kind`s here to print an actionable next step instead of string-matching a
 * message. We accept either the bare value (a `Result.error` handed up directly)
 * or the wrapped `Error` carrying it.
 */
function extractQueryError(error: unknown): QueryError | null {
  if (isQueryError(error))
    return error
  const tagged = (error as { queryError?: unknown } | null)?.queryError
  return isQueryError(tagged) ? tagged : null
}

function extractEngineError(error: unknown): EngineError | null {
  if (isEngineError(error))
    return error
  const tagged = (error as { engineError?: unknown } | null)?.engineError
  return isEngineError(tagged) ? tagged : null
}

function extractAnalysisError(error: unknown): AnalysisError | null {
  if (isAnalysisError(error))
    return error
  const tagged = (error as { analysisError?: unknown } | null)?.analysisError
  // A required step that failed often wraps an EngineError as its `cause`;
  // surface that hint too, so a degraded report points at the real fix.
  return isAnalysisError(tagged) ? tagged : null
}

/**
 * Next-step hint for a modelled upstream failure, keyed off its discriminant.
 * Returns '' when the generic formatter already says enough. Centralised here so
 * every error the shell reports benefits without per-command branching.
 */
function suggestionForTypedError(error: unknown): string {
  const query = extractQueryError(error)
  if (query) {
    switch (query.kind) {
      case 'unresolvable-dataset':
        return 'This breakdown spans separate stored tables. Re-run with --live to compute it from the GSC API.'
      case 'unsupported-capability':
        return `The local engine lacks the "${query.capability}" capability for ${query.context}. Re-run with --live.`
      case 'missing-date-range':
        return 'Add a date range, e.g. --start YYYY-MM-DD --end YYYY-MM-DD.'
      case 'invalid-row-limit':
      case 'invalid-start-row':
      case 'invalid-data-state':
      case 'invalid-aggregation-type':
      case 'invalid-builder-state':
        return ''
    }
  }

  const analysis = extractAnalysisError(error)
  if (analysis) {
    switch (analysis.kind) {
      case 'missing-report-param':
        return `Report "${analysis.report}" needs ${flagForParam(analysis.param)}.`
      case 'missing-comparison-window':
        return `Report "${analysis.report}" is a comparison report; pass --vs prev-period (or --vs yoy).`
      case 'missing-brand-terms':
        return 'Pass --brand-terms to segment branded vs non-branded queries.'
      case 'unknown-report':
        return `Unknown report. Available: ${analysis.available.join(', ')}.`
      case 'unknown-analyzer':
        return 'Run `gscdump report list` to see available reports/analyzers.'
      case 'required-step-failed':
        // The underlying engine failure (if any) carries the real fix.
        return suggestionForTypedError(analysis.cause)
    }
  }

  const engine = extractEngineError(error)
  if (engine) {
    switch (engine.kind) {
      case 'attached-table-missing':
        return `Local store is missing table(s): ${engine.missing.join(', ')}. Run \`gscdump sync\` first, or pass --live.`
      case 'analyzer-not-found':
      case 'analyzer-capability-missing':
        return 'This analysis is not available for the chosen source. Re-run with --live.'
      case 'invalid-year-month':
      case 'invalid-snapshot-filename':
      case 'invalid-schema-identifier':
        return 'The local store appears corrupt. Re-run `gscdump sync` to rebuild it.'
      default:
        return ''
    }
  }

  return ''
}

/**
 * Thrown by `resolveAnalysisSource`'s `runAnalysis` closure when the
 * dispatcher reports `AnalyzerCapabilityError`. Carries `mode` so the
 * top-level handler can render the right "next step" hint.
 */
export class LocalStoreUnsupportedError extends Error {
  readonly tool: string
  readonly mode: 'live' | 'local'
  constructor(tool: string, mode: 'live' | 'local') {
    super(mode === 'live'
      ? `The live API cannot run analysis "${tool}". Run gscdump sync, then retry without --live.`
      : `Local data cannot run analysis "${tool}".`)
    this.name = 'LocalStoreUnsupportedError'
    this.tool = tool
    this.mode = mode
  }
}

/**
 * Heuristic: does this error look like a credentials problem? The shell then
 * prints where each credential came from, because a stale `.env` shadowing
 * fresh saved tokens is the usual cause.
 */
export function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (!msg)
    return false
  return /\b(?:401|unauthorized|invalid_grant|invalid_token|insufficient.*scope|invalid_client|token has been expired|token has been revoked)\b/.test(msg)
    || msg.includes('oauth2.googleapis.com/token')
}

/** CLI flag for an analysis parameter name, e.g. `prevStartDate` → `--prev-start`. */
export function flagForParam(param: string): string {
  const known: Record<string, string> = {
    prevStartDate: '--prev-start',
    prevEndDate: '--prev-end',
    startDate: '--start',
    endDate: '--end',
  }
  return known[param] ?? `--${param.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
}

const PARAM_NAME_RE = /\b(prevStartDate|prevEndDate|brandTerms)\b/g

// Built-in error types that signal a defect in gscdump, not a user mistake.
const DEFECT_ERRORS = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError'])

export type CliErrorReport
  = | { kind: 'usage', message: string }
    | { kind: 'expected', message: string, hint: string, showAuthSources: boolean }
    | { kind: 'defect', message: string, stack: string }

/**
 * Sort a thrown value into what the shell prints. Expected failures get one
 * line and an optional next step. Only defects carry a stack.
 */
export function describeCliError(error: unknown): CliErrorReport {
  if (isUsageError(error))
    return { kind: 'usage', message: error.message }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as { cause?: unknown }).cause
    const reason = cause instanceof Error ? cause.message : 'no response'
    return { kind: 'expected', message: `Network request failed: ${reason}`, hint: 'Check your connection, then try again.', showAuthSources: false }
  }
  if (error instanceof Error && DEFECT_ERRORS.has(error.constructor.name))
    return { kind: 'defect', message: `${error.name}: ${error.message}`, stack: error.stack ?? '' }

  if (error instanceof LocalStoreUnsupportedError) {
    return {
      kind: 'expected',
      message: error.message,
      hint: error.mode === 'local' ? 'Pass --live to run against the GSC API.' : '',
      showAuthSources: false,
    }
  }
  const classified = classifyError(error)
  if (classified.message === HOSTED_KEY_REJECTED)
    return { kind: 'expected', message: classified.message, hint: '', showAuthSources: false }
  const message = classified.message.replace(PARAM_NAME_RE, name => flagForParam(name))
  const typedHint = suggestionForTypedError(error)
  return {
    kind: 'expected',
    message,
    hint: typedHint || suggestionForGscError(classified),
    showAuthSources: classified.kind === 'auth-expired' || classified.kind === 'permission-denied' || isAuthError(error),
  }
}

export interface ReportCliErrorOptions {
  color: boolean
  /** Rendered usage of the selected command, shown above a usage error. */
  usage?: () => Promise<string>
  /** Where the credentials came from, shown under an auth failure. */
  authSources?: () => Promise<string>
  write?: (text: string) => void
}

/** Print a thrown value to stderr in its final form. The shell calls this once. */
export async function reportCliError(error: unknown, options: ReportCliErrorOptions): Promise<void> {
  const report = describeCliError(error)
  const red = (text: string): string => options.color ? `\x1B[31m${text}\x1B[0m` : text
  const lines: string[] = []
  switch (report.kind) {
    case 'usage':
      if (options.usage)
        lines.push(await options.usage(), '')
      lines.push(red(report.message))
      break
    case 'expected':
      lines.push(red(`Error: ${report.message}`))
      if (report.hint)
        lines.push(report.hint)
      if (report.showAuthSources && options.authSources)
        lines.push('', await options.authSources())
      break
    case 'defect':
      lines.push(red(`Unexpected error. Report it at https://github.com/harlan-zw/gscdump/issues`), report.stack || report.message)
      break
  }
  const text = lines.join('\n')
  const write = options.write ?? ((value: string) => console.error(value))
  write(options.color ? text : text.replace(ANSI_RE, ''))
}
