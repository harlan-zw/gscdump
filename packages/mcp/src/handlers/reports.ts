/**
 * MCP report handlers — `list-reports`, `run-report`. Backed by
 * `defaultReportRegistry` + `runReport` from `@gscdump/analysis/report`.
 *
 * Source: live GSC API only. Local-store mode requires the user's Parquet
 * directory which the MCP server has no access to.
 */

import type { ComparisonMode, WindowPreset } from '@gscdump/engine/period'
import type { ReportContext, ReportResult } from '@gscdump/engine/report'
import type { z } from 'zod'
import type { HandlerContext, runReportInput } from '../types'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { defaultReportRegistry, runReport } from '@gscdump/analysis/report'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { resolveWindow } from '@gscdump/engine/period'

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

export async function runReportHandler(
  input: z.infer<typeof runReportInput>,
  ctx: HandlerContext,
): Promise<ReportResult> {
  const report = defaultReportRegistry.getReport(input.id)
  if (!report)
    throw new Error(`Unknown report id "${input.id}". Available: ${defaultReportRegistry.listReportIds().join(', ')}`)

  const preset = input.period
    ? (PERIOD_ALIASES[input.period.toLowerCase()] ?? null)
    : report.defaultPeriod
  if (!preset)
    throw new Error(`Unknown period "${input.period}". Supported: 7d, 28d, 30d, 90d, 180d, 365d, mtd, ytd, custom.`)

  const comparison = input.comparison
    ? (COMPARISON_ALIASES[input.comparison.toLowerCase()] ?? null)
    : report.defaultComparison
  if (!comparison)
    throw new Error(`Unknown comparison "${input.comparison}". Supported: none, prev-period, yoy.`)

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
  return runReport(report, { source, analyzers: defaultAnalyzerRegistry, ctx: reportCtx })
}
