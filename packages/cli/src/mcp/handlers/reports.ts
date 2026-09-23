/**
 * MCP report handlers — `list-reports`, `run-report`. Backed by
 * `defaultReportRegistry` + `runReport` from `@gscdump/analysis/report`.
 *
 * Source: live GSC API only. Reports that require the local Store use the CLI.
 */

import type { DefinedReport, ReportArgsSpec, ReportContext, ReportPlanStep, ReportResult } from '@gscdump/engine/report'
import type { SourceCapabilities } from '@gscdump/engine/source'
import type { Result } from 'gscdump/result'
import type { z } from 'zod'
import type { WindowDefaults, WindowFlagError } from '../../window'
import type { McpHandlerError } from '../errors'
import type { HandlerContext } from '../types'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { defaultReportRegistry, runReport } from '@gscdump/analysis/report'
import { createGscApiQuerySource, GSC_API_CAPABILITIES } from '@gscdump/engine-gsc-api'
import { getLatestGscDate } from 'gscdump/dates'
import { err, ok, unwrapResult } from 'gscdump/result'
import { parseWindowFlags, windowFlagErrorToException } from '../../window'
import { enrichToolError, mcpHandlerErrors, mcpHandlerErrorToException } from '../errors'
import { runReportInput } from '../types'

function reportWindowDefaults(report: DefinedReport): WindowDefaults {
  if (report.defaultPeriod === 'custom')
    throw new Error(`Report "${report.id}" declares a custom default period. Declare a preset.`)
  return { preset: report.defaultPeriod, comparison: report.defaultComparison }
}

function toMcpWindowError(error: WindowFlagError): McpHandlerError {
  switch (error.kind) {
    case 'unknown-period':
      return mcpHandlerErrors.unknownPeriod(error.value)
    case 'unknown-comparison':
      return mcpHandlerErrors.unknownComparison(error.value)
    default:
      return mcpHandlerErrors.invalidWindow(error.message)
  }
}

export interface ListReportsResult {
  id: string
  description: string
  defaultPeriod: string
  defaultComparison: string
  argsSpec: ReportArgsSpec
}

function mcpArgName(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function supportsLiveSteps(steps: readonly ReportPlanStep[]): boolean {
  const capabilities: SourceCapabilities = GSC_API_CAPABILITIES
  const supported = steps.map((step) => {
    const analyzer = defaultAnalyzerRegistry.resolveAnalyzer(step.type, false)
    return !!analyzer && analyzer.requires.every(capability =>
      capability !== 'executeSql' && capabilities[capability] === true,
    )
  })
  return supported.some(Boolean) && steps.every((step, index) => !step.required || supported[index])
}

function supportsLiveReport(report: DefinedReport): boolean {
  const args = Object.entries(report.argsSpec)
  if (args.some(([name]) => !Object.hasOwn(runReportInput.shape, mcpArgName(name))))
    return false

  // Plans declare Analyzer requirements. Discovery supplies placeholder inputs
  // to inspect the plan without authentication or Google requests.
  const params = Object.fromEntries(args.map(([name, arg]) => [
    mcpArgName(name),
    arg.default ?? (arg.type === 'number' ? 1 : arg.type === 'boolean' ? false : 'mcp-discovery'),
  ]))
  const window = unwrapResult(parseWindowFlags({}, reportWindowDefaults(report), getLatestGscDate()), windowFlagErrorToException)
  return supportsLiveSteps(report.plan(params, window))
}

export function listReports(): ListReportsResult[] {
  return defaultReportRegistry.listReports().filter(supportsLiveReport).map(r => ({
    id: r.id,
    description: r.description,
    defaultPeriod: r.defaultPeriod.replace(/^last-/, ''),
    defaultComparison: r.defaultComparison,
    argsSpec: Object.fromEntries(Object.entries(r.argsSpec).map(([name, arg]) => [mcpArgName(name), arg])),
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
  getContext: () => Promise<HandlerContext> | HandlerContext,
): Promise<Result<ReportResult, McpHandlerError>> {
  const report = defaultReportRegistry.getReport(input.id)
  if (!report)
    return err(mcpHandlerErrors.unknownReport(input.id, listReports().map(report => report.id)))
  if (!supportsLiveReport(report))
    return err(mcpHandlerErrors.unsupportedReport(input.id, listReports().map(report => report.id)))

  // Live reads end on the newest final GSC date, never on today.
  const parsed = parseWindowFlags({
    period: input.period,
    vs: input.comparison,
    start: input.start,
    end: input.end,
    prevStart: input.prevStart,
    prevEnd: input.prevEnd,
  }, reportWindowDefaults(report), getLatestGscDate())
  if (!parsed.ok)
    return err(toMcpWindowError(parsed.error))
  const window = parsed.value

  const params = Object.fromEntries(Object.keys(report.argsSpec).map((name) => {
    const key = mcpArgName(name) as keyof typeof input
    return [key, input[key]]
  }).filter(([, value]) => value !== undefined))
  if (!supportsLiveSteps(report.plan(params, window)))
    return err(mcpHandlerErrors.unsupportedReport(input.id, listReports().map(report => report.id)))

  const ctx = await getContext()
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
  getContext: () => Promise<HandlerContext> | HandlerContext,
): Promise<ReportResult> {
  return unwrapResult(
    await runReportHandlerResult(input, getContext).catch((thrown: unknown) => {
      throw enrichToolError(thrown) ?? thrown
    }),
    mcpHandlerErrorToException,
  )
}
