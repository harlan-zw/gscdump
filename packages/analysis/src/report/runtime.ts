/**
 * Report runtime — `runReport`, `dryRunReport`.
 *
 * Composition pattern: each
 * `ReportPlanStep` is dispatched through `runAnalyzerFromSource` in parallel,
 * results land in a keyed bag, the report's `reduce` shapes that into
 * sections. Required-step failure throws; optional-step failure flips
 * `coverage: 'partial'` and `meta.degraded: true`, and any section fed only
 * by failed steps is replaced with an explicit `severity: 'unknown'` shape
 * (see `markUnavailableSections`).
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
  fetchBudget: number | undefined,
): Promise<StepOutcome> {
  const params = {
    ...step.params,
    ...(fetchBudget != null ? { fetchBudget } : {}),
    type: step.type,
  } as AnalysisParams
  return runAnalyzerFromSource(source, params, analyzers)
    .then((result): StepOutcome => ({
      state: {
        key: step.key,
        type: step.type,
        status: 'done',
        ...(result.meta.coverage ? { coverage: result.meta.coverage } : {}),
      },
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
 * Replace a section that no surviving step feeds. `reduce` reads a bag that
 * simply omits failed steps, so every "count the rows" expression in it sees
 * `[]` — indistinguishable from an analyzer that legitimately returned zero
 * rows. That is how a report whose analyzers all threw came back
 * `severity: 'info'`, `"0 clusters covering 0 keywords"`, `coverage: 'partial'`
 * — confident, valid-looking, and false.
 *
 * The runtime is the only layer that knows a step errored, so it is the only
 * layer that can tell those two states apart. Rather than trusting each
 * report's `reduce` to check (it can't — it never sees the failure), the
 * fabricated content is stripped here: no findings and no artifact
 * to re-run, and a severity outside the info→high ladder.
 *
 * `coverage` deliberately stays `partial`: it already means "backing data is
 * incomplete", consumers key their partial-badge off it, and widening
 * `ReportCoverage` would silently drop that badge on older consumers.
 */
function unavailableSection(section: ReportSection, failedKeys: string[]): ReportSection {
  return {
    id: section.id,
    title: section.title,
    severity: 'unknown',
    summary: { magnitudeLabel: `unavailable — ${failedKeys.join(', ')} failed` },
    findings: [],
    coverage: 'partial',
  }
}

/**
 * A section is unavailable when at least one step declares it via
 * `ReportPlanStep.feeds` (defaulting to the step key) and EVERY such step
 * errored. A section fed by a mix still has real content and is untouched.
 * A section no step claims is untouched too — `report-unavailable.test.ts`
 * is the guard against that gap going unnoticed.
 */
function markUnavailableSections(
  sections: readonly ReportSection[],
  steps: readonly ReportPlanStep[],
  outcomes: readonly StepOutcome[],
): ReportSection[] {
  const failedKeys = new Set(
    outcomes.filter(o => o.state.status === 'error').map(o => o.state.key),
  )
  if (failedKeys.size === 0)
    return [...sections]

  const feedersBySection = new Map<string, string[]>()
  for (const step of steps) {
    for (const sectionId of step.feeds ?? [step.key]) {
      const feeders = feedersBySection.get(sectionId)
      if (feeders)
        feeders.push(step.key)
      else
        feedersBySection.set(sectionId, [step.key])
    }
  }

  return sections.map((section) => {
    const feeders = feedersBySection.get(section.id)
    if (!feeders?.length || !feeders.every(k => failedKeys.has(k)))
      return section
    return unavailableSection(section, feeders)
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
 * runtime additionally marks `meta.degraded` when any step errored, and
 * rewrites sections whose feeding steps ALL failed; see
 * `markUnavailableSections`).
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
    steps.map(s => executeStep(opts.source, opts.analyzers, s, opts.ctx.fetchBudget)),
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
  const sections: ReportSection[] = markUnavailableSections(reduced.sections, steps, outcomes)

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
