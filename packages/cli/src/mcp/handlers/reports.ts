/**
 * MCP report handlers — `list-reports`, `run-report`. Backed by
 * `defaultReportRegistry` + `runReport` from `@gscdump/analysis/report`.
 *
 * Source: live GSC API only. Local-store mode requires the user's Parquet
 * directory which the MCP server has no access to.
 */

import type { ComparisonMode, WindowPreset } from '@gscdump/engine/period'
import type { ReportContext, ReportResult } from '@gscdump/engine/report'
import type { Result } from 'gscdump/result'
import type { z } from 'zod'
import type { McpHandlerError } from '../errors'
import type { HandlerContext, runReportInput } from '../types'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { defaultReportRegistry, runReport } from '@gscdump/analysis/report'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { resolveWindow } from '@gscdump/engine/period'
import { err, ok, unwrapResult } from 'gscdump/result'
import { enrichToolError, mcpHandlerErrors, mcpHandlerErrorToException } from '../errors'

const PERIOD_ALIASES: Record<string, WindowPreset> = {
  '7d': 'last-7d',
  '28d': 'last-28d',
  '30d': 'last-30d',
  '90d': 'last-90d',
  '180d': 'last-180d',
  '365d': 'last-365d',
  'mtd': 'mtd',
  'ytd': 'ytd',
  'custom': 'custom',
}

const COMPARISON_ALIASES: Record<string, ComparisonMode> = {
  'none': 'none',
  'prev': 'prev-period',
  'prev-period': 'prev-period',
  'prior': 'prev-period',
  'yoy': 'yoy',
}

export interface ListReportsResult {
  id: string
  description: string
  defaultPeriod: string
  defaultComparison: string
  argsSpec: Record<string, unknown>
}

export function listReports(): ListReportsResult[] {
  return defaultReportRegistry.listReports().map(r => ({
    id: r.id,
    description: r.description,
    defaultPeriod: r.defaultPeriod,
    defaultComparison: r.defaultComparison,
    argsSpec: r.argsSpec,
  }))
}

/**
 * Errors-as-values core for {@link runReportHandler}: the request-parsing
 * boundary (unknown report id / period / comparison an agent passed) returns a
 * typed `McpHandlerError` so callers branch on `kind` rather than the message.
 * The downstream `runReport` failures (`AnalysisError`/`EngineError`) are
 * defects* from this core's view and still propagate — `runReportHandler`
 * enriches them into a typed MCP payload at the throwing boundary.
 */
export async function runReportHandlerResult(
  input: z.infer<typeof runReportInput>,
  ctx: HandlerContext,
): Promise<Result<ReportResult, McpHandlerError>> {
  const report = defaultReportRegistry.getReport(input.id)
  if (!report)
    return err(mcpHandlerErrors.unknownReport(input.id, defaultReportRegistry.listReportIds()))

  const preset = input.period
    ? (PERIOD_ALIASES[input.period.toLowerCase()] ?? null)
    : report.defaultPeriod
  if (!preset)
    return err(mcpHandlerErrors.unknownPeriod(input.period ?? ''))

  const comparison = input.comparison
    ? (COMPARISON_ALIASES[input.comparison.toLowerCase()] ?? null)
    : report.defaultComparison
  if (!comparison)
    return err(mcpHandlerErrors.unknownComparison(input.comparison ?? ''))

  const window = resolveWindow({
    preset,
    comparison,
    start: input.start,
    end: input.end,
  })
  if (input.prevStart && input.prevEnd)
    window.comparison = { start: input.prevStart, end: input.prevEnd }

  const params: Record<string, unknown> = {}
  if (input.maxFindings != null)
    params.maxFindings = input.maxFindings

  const source = createGscApiQuerySource({ client: ctx.client, siteUrl: input.siteUrl })
  const reportCtx: ReportContext = {
    site: input.siteUrl,
    window,
    params,
    registryVersion: defaultReportRegistry.version,
  }
  return ok(await runReport(report, { source, analyzers: defaultAnalyzerRegistry, ctx: reportCtx }))
}

/**
 * MCP `run-report` handler. Thin throwing wrapper over
 * {@link runReportHandlerResult}: collapses the typed request-boundary error
 * back to a throw (the MCP server turns it into an error response) and rewrites
 * an upstream modelled failure (`AnalysisError`/`EngineError`) into a
 * `[analysis:kind]` / `[engine:kind]` payload so the agent sees the modelled
 * cause instead of a bare message.
 */
export async function runReportHandler(
  input: z.infer<typeof runReportInput>,
  ctx: HandlerContext,
): Promise<ReportResult> {
  return unwrapResult(
    await runReportHandlerResult(input, ctx).catch((thrown: unknown) => {
      throw enrichToolError(thrown) ?? thrown
    }),
    mcpHandlerErrorToException,
  )
}
