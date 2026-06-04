// Report-`plan()` precondition guards. Each report's `plan` is a synchronous
// callback the engine `defineReport` invokes expecting it to throw on bad
// params, so these expose a `*Result` core (the modelled, caller-actionable
// failure — a missing `--target`/`--topic`/`--brand-terms`, a comparison report
// run without a `--vs` window) plus a thin throwing wrapper the callbacks call.
// The throwing wrapper maps the typed `AnalysisError` through
// `analysisErrorToException`, keeping the verbatim CLI-facing message so
// existing `/--target/`, `/comparison window/` assertions still match while the
// typed union rides along on `.analysisError`.

import type { ResolvedWindow } from '@gscdump/engine/period'
import type { Result } from 'gscdump/result'
import type { AnalysisError } from '../errors'
import { err, ok, unwrapResult } from 'gscdump/result'
import { analysisErrors, analysisErrorToException } from '../errors'

/** Core: a report param that must be a non-empty string was supplied. */
export function requireReportParamResult(
  report: string,
  param: string,
  value: string | undefined,
  message: string,
): Result<string, AnalysisError> {
  return value && value.trim()
    ? ok(value)
    : err(analysisErrors.missingReportParam(report, param, message))
}

export function requireReportParam(
  report: string,
  param: string,
  value: string | undefined,
  message: string,
): string {
  return unwrapResult(requireReportParamResult(report, param, value, message), analysisErrorToException)
}

/** Core: a comparison-shaped report's window carries a resolved `comparison`. */
export function requireComparisonWindowResult(
  report: string,
  window: ResolvedWindow,
  message: string,
): Result<NonNullable<ResolvedWindow['comparison']>, AnalysisError> {
  return window.comparison
    ? ok(window.comparison)
    : err(analysisErrors.missingComparisonWindow(report, message))
}

export function requireComparisonWindow(
  report: string,
  window: ResolvedWindow,
  message: string,
): NonNullable<ResolvedWindow['comparison']> {
  return unwrapResult(requireComparisonWindowResult(report, window, message), analysisErrorToException)
}
