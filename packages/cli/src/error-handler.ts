import type { AnalysisError } from '@gscdump/analysis/errors'
import type { EngineError } from '@gscdump/engine/errors'
import type { QueryError } from 'gscdump/query'
import process from 'node:process'
import { isAnalysisError } from '@gscdump/analysis/errors'
import { isEngineError } from '@gscdump/engine/errors'
import { classifyError } from 'gscdump/errors'
import { isQueryError } from 'gscdump/query'
import { formatAuthProvenance, isAuthError } from './auth'

const QUOTA_MESSAGE_RE = /quota|rate\s*limit/i

/** CLI-owned rendering for the package's structured Google API errors. */
function formatErrorForCli(cause: unknown): string {
  const error = classifyError(cause)
  const lines = [`\x1B[31m${error.message}\x1B[0m`]
  let suggestion = ''

  switch (error.kind) {
    case 'auth-expired':
      suggestion = 'Run `gscdump auth` to re-authenticate.'
      break
    case 'rate-limited': {
      const retryIn = error.retryAfter ? `${error.retryAfter}s` : 'a few minutes'
      if (QUOTA_MESSAGE_RE.test(error.message)) {
        suggestion = error.message.includes('Indexing API')
          ? 'Indexing API quota exhausted (~200/day). Try again tomorrow.'
          : `Quota or rate limit hit (Search Analytics ~25000/day). Try again in ${retryIn}.`
      }
      else {
        suggestion = `Rate limited. Slow down requests. Try again in ${retryIn}.`
      }
      break
    }
  }

  if (suggestion)
    lines.push('', suggestion)
  return lines.join('\n')
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
  const tagged = (error as { queryError?: unknown }).queryError
  return isQueryError(tagged) ? tagged : null
}

function extractEngineError(error: unknown): EngineError | null {
  if (isEngineError(error))
    return error
  const tagged = (error as { engineError?: unknown }).engineError
  return isEngineError(tagged) ? tagged : null
}

function extractAnalysisError(error: unknown): AnalysisError | null {
  if (isAnalysisError(error))
    return error
  const tagged = (error as { analysisError?: unknown }).analysisError
  // A required step that failed often wraps an EngineError as its `cause`;
  // surface that hint too, so a degraded report points at the real fix.
  return isAnalysisError(tagged) ? tagged : null
}

/**
 * Next-step hint for a modelled upstream failure, keyed off its discriminant.
 * Returns '' when the generic formatter already says enough. Centralised here so
 * every command's `.catch(gscErrorHandler)` benefits without per-command branching.
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
        return `Report "${analysis.report}" needs --${analysis.param}.`
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
    super(`analysis "${tool}" has no implementation for the ${mode} source`)
    this.name = 'LocalStoreUnsupportedError'
    this.tool = tool
    this.mode = mode
  }
}

/**
 * .catch() handler for CLI errors — prints a formatted message and exits 1.
 * Use: somePromise.catch(gscErrorHandler)
 *
 * On auth-shaped errors (401, invalid_grant, etc.) we append a provenance
 * dump so the user can see *which* config source supplied the broken
 * credential — the most common cause is a stale `.env` shadowing fresh
 * saved tokens.
 */
export async function gscErrorHandler(error: unknown): Promise<never> {
  console.error()
  if (error instanceof LocalStoreUnsupportedError) {
    console.error(formatErrorForCli(error))
    if (error.mode === 'local')
      console.error('Pass --live to run against the GSC API.')
    console.error()
    process.exit(1)
  }
  console.error(formatErrorForCli(error))

  // Modelled upstream failures (QueryError / EngineError / AnalysisError) carry a
  // `kind` the generic formatter can't see; render the actionable next step.
  const typedHint = suggestionForTypedError(error)
  if (typedHint) {
    console.error()
    console.error(typedHint)
  }

  if (isAuthError(error)) {
    console.error()
    console.error(await formatAuthProvenance())
  }
  console.error()
  process.exit(1)
}
