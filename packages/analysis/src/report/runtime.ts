/**
 * Report runtime — `runReport`, `dryRunReport`.
 *
 * Composition pattern: each
 * `ReportPlanStep` is dispatched through `runAnalyzerFromSource` in parallel,
 * results land in a keyed bag, the report's `reduce` shapes that into
 * sections. Required-step failure throws; optional-step failure flips
 * `coverage: 'partial'` and `meta.degraded: true`.
 */

import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalyzerRegistry } from '@gscdump/engine/analyzer'
import type {
  DefinedReport,
  ReportContext,
  ReportParams,
  ReportPlanStep,
  ReportResult,
  ReportSection,
  ReportStepStateMeta,
} from '@gscdump/engine/report'
import type { AnalysisQuerySource } from '@gscdump/engine/source'
import type { Result } from 'gscdump/result'
import type { AnalysisError } from '../errors'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { computeInputHash } from '@gscdump/engine/report'
import { err, ok, unwrapResult } from 'gscdump/result'
import { analysisErrors, analysisErrorToException } from '../errors'

export interface RunReportOptions<P extends ReportParams = ReportParams> {
  source: AnalysisQuerySource
  analyzers: AnalyzerRegistry
  ctx: ReportContext<P>
}

interface StepOutcome {
  state: ReportStepStateMeta
  result?: AnalysisResult
  /**
   * The original thrown value on failure, carried so a required-step
   *  failure can surface it as the `AnalysisError`'s `cause`.
   */
  cause?: unknown
}

async function executeStep(
  source: AnalysisQuerySource,
  analyzers: AnalyzerRegistry,
  step: ReportPlanStep,
): Promise<StepOutcome> {
  const params = { ...step.params, type: step.type } as AnalysisParams
  return runAnalyzerFromSource(source, params, analyzers)
    .then((result): StepOutcome => ({
      state: { key: step.key, type: step.type, status: 'done' },
      result,
    }))
    .catch((thrown: Error): StepOutcome => {
      const message = thrown?.message ?? String(thrown)
      return {
        state: { key: step.key, type: step.type, status: 'error', error: message },
        cause: thrown,
      }
    })
}

/**
 * `Result`-returning core for {@link runReport}. Models the one
 * caller-actionable failure of a structurally-valid report run: a required
 * step's analyzer threw (`required-step-failed`, with the underlying error as
 * `cause`). Hosts can map that to a 4xx/partial response instead of catching an
 * untyped `Error`.
 *
 * Steps execute in parallel via `Promise.all`. The report's `reduce` is invoked
 * with a results bag that only contains successful steps — sections that
 * depended on a failed step should set their own `coverage: 'partial'` (the
 * runtime additionally marks `meta.degraded` when any step errored).
 *
 * The report's own `plan()` param-validation throws (`--target` etc.) are
 * defects from this core's perspective and still propagate; those are modelled
 * at the report-definition boundary, not here.
 */
export async function runReportResult<P extends ReportParams = ReportParams>(
  report: DefinedReport<P>,
  opts: RunReportOptions<P>,
): Promise<Result<ReportResult, AnalysisError>> {
  const startedAt = Date.now()
  const generatedAt = new Date(startedAt).toISOString()

  const inputHash = await computeInputHash({
    id: report.id,
    site: opts.ctx.site,
    window: opts.ctx.window,
    params: opts.ctx.params,
    registryVersion: opts.ctx.registryVersion,
  })

  const steps = report.plan(opts.ctx.params, opts.ctx.window)
  const outcomes = await Promise.all(
    steps.map(s => executeStep(opts.source, opts.analyzers, s)),
  )

  const required = new Map<string, ReportPlanStep>(
    steps.filter(s => s.required).map(s => [s.key, s]),
  )

  const errored = outcomes.filter(o => o.state.status === 'error')
  for (const o of errored) {
    if (required.has(o.state.key)) {
      return err(analysisErrors.requiredStepFailed(
        report.id,
        o.state.key,
        o.state.error ?? 'unknown error',
        o.cause,
      ))
    }
  }

  const resultsByKey: Record<string, AnalysisResult> = {}
  for (const o of outcomes) {
    if (o.result)
      resultsByKey[o.state.key] = o.result
  }

  const reduced = report.reduce(resultsByKey, opts.ctx)
  const sections: ReportSection[] = reduced.sections

  const degraded = errored.length > 0
  const stepStates: ReportStepStateMeta[] = outcomes.map(o => o.state)

  return ok({
    id: report.id,
    site: opts.ctx.site,
    inputHash,
    generatedAt,
    window: opts.ctx.window,
    sections,
    meta: {
      durationMs: Date.now() - startedAt,
      rowsScanned: 0,
      degraded,
      steps: stepStates,
    },
  })
}

/**
 * Throwing wrapper over {@link runReportResult}, preserving the historical
 * call-site ergonomics (a required-step failure rejects). The thrown message is
 * kept verbatim (`runReport(id): required step "k" failed: ...`) so existing
 * assertions hold; the typed `AnalysisError` is reachable via `.analysisError`
 * and the original failure via `.cause`.
 */
export async function runReport<P extends ReportParams = ReportParams>(
  report: DefinedReport<P>,
  opts: RunReportOptions<P>,
): Promise<ReportResult> {
  return unwrapResult(await runReportResult(report, opts), analysisErrorToException)
}

export interface DryRunReportResult {
  steps: { key: string, type: string, estRowsScanned?: number }[]
  windowResolved: { start: string, end: string, days: number }
}

/**
 * Plan-only preview. v1 doesn't compute row estimates — analyzer-level
 * cost models don't exist yet — so `estRowsScanned` is left undefined.
 * Useful right now only as an "is this report wired up correctly?" check.
 */
export async function dryRunReport<P extends ReportParams = ReportParams>(
  report: DefinedReport<P>,
  ctx: ReportContext<P>,
): Promise<DryRunReportResult> {
  const steps = report.plan(ctx.params, ctx.window)
  return {
    steps: steps.map(s => ({ key: s.key, type: s.type })),
    windowResolved: { start: ctx.window.start, end: ctx.window.end, days: ctx.window.days },
  }
}
