// The typed error (`E`) channel for `@gscdump/analysis`'s modelled,
// caller-actionable failures, mirroring the `gscdump`/`@gscdump/engine`
// `kind`-discriminated convention (not `_tag`). Pairs with `Result` from
// `gscdump/result`: a `fooResult(): Result<A, AnalysisError>` core models the
// expected failures, a thin throwing `foo()` wrapper preserves existing call
// sites via `unwrapResult(..., analysisErrorToException)`.
//
// What is modelled here: the report/analyzer boundary mistakes a caller can
// fix — a report invoked without its required param (`--target`, `--topic`,
// `--brand-terms`), a comparison-shaped report run without a `--vs` window, a
// brand analyzer asked to segment without brand terms, an unknown report or
// analyzer id, and a required report step that failed (the step's underlying
// error — often an `EngineError` — rides along as `cause`).
//
// What is NOT modelled — defects — keep propagating as exceptions, including
// a `defineReport` invariant violation.
//
// Leaf module: imports nothing, so no report/analyzer module that depends on it
// can form an import cycle.

export type AnalysisErrorKind
  = | 'missing-report-param'
    | 'missing-comparison-window'
    | 'missing-brand-terms'
    | 'unknown-report'
    | 'unknown-analyzer'
    | 'required-step-failed'

export type AnalysisError
  = | { kind: 'missing-report-param', report: string, param: string, message: string }
    | { kind: 'missing-comparison-window', report: string, message: string }
    | { kind: 'missing-brand-terms', message: string }
    | { kind: 'unknown-report', report: string, available: readonly string[], message: string }
    | { kind: 'unknown-analyzer', analyzer: string, message: string }
    // A required report step's analyzer run threw. NOT a defect: the report is
    // structurally valid, one of its inputs was unavailable, so the caller can
    // retry/narrow. `cause` carries the original thrown value (frequently an
    // `EngineError`); `stepKey` names the step; `stepError` is its rendered
    // message (kept verbatim so existing `/required step "k"/` assertions hold).
    | { kind: 'required-step-failed', report: string, stepKey: string, stepError: string, message: string, cause?: unknown }

export const analysisErrors = {
  missingReportParam(report: string, param: string, message: string): AnalysisError {
    return { kind: 'missing-report-param', report, param, message }
  },
  missingComparisonWindow(report: string, message: string): AnalysisError {
    return { kind: 'missing-comparison-window', report, message }
  },
  missingBrandTerms(): AnalysisError {
    return { kind: 'missing-brand-terms', message: 'Brand analysis requires brandTerms' }
  },
  unknownReport(report: string, available: readonly string[]): AnalysisError {
    return { kind: 'unknown-report', report, available, message: `unknown report "${report}"; available: ${available.join(', ')}` }
  },
  unknownAnalyzer(analyzer: string): AnalysisError {
    return { kind: 'unknown-analyzer', analyzer, message: `unknown analyzer "${analyzer}"` }
  },
  requiredStepFailed(report: string, stepKey: string, stepError: string, cause?: unknown): AnalysisError {
    return {
      kind: 'required-step-failed',
      report,
      stepKey,
      stepError,
      cause,
      message: `runReport(${report}): required step "${stepKey}" failed: ${stepError}`,
    }
  },
} as const

const ANALYSIS_ERROR_KINDS = new Set<AnalysisErrorKind>([
  'missing-report-param',
  'missing-comparison-window',
  'missing-brand-terms',
  'unknown-report',
  'unknown-analyzer',
  'required-step-failed',
])

export function isAnalysisError(value: unknown): value is AnalysisError {
  return typeof value === 'object'
    && value !== null
    && ANALYSIS_ERROR_KINDS.has((value as { kind?: AnalysisErrorKind }).kind as AnalysisErrorKind)
    && typeof (value as { message?: unknown }).message === 'string'
}

/** The human-readable rendering of an `AnalysisError`, for logs and string sinks. */
export function formatAnalysisError(error: AnalysisError): string {
  return error.message
}

/**
 * Re-raises an `AnalysisError` value as a generic `Error`, stashing the union
 * under `.analysisError` for stack-walking and preserving the original `cause`
 * (so a `required-step-failed` keeps the underlying thrown value reachable).
 * Used by the throwing wrappers over the `Result`-returning cores. The thrown
 * `.message` is kept verbatim from the union, so existing message-regex
 * assertions (`/--target/`, `/comparison window/`, `/required step "k"/`)
 * continue to match.
 */
export function analysisErrorToException(error: AnalysisError): Error {
  const exception = new Error(error.message)
  if ('cause' in error && error.cause !== undefined)
    (exception as Error & { cause?: unknown }).cause = error.cause
  ;(exception as Error & { analysisError?: AnalysisError }).analysisError = error
  return exception
}
