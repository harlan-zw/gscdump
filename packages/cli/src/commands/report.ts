import type { ComparisonMode, WindowPreset } from '@gscdump/engine/period'
import type { DefinedReport, ReportArgsSpec, ReportContext, ReportParams } from '@gscdump/engine/report'
import type { CommandDef } from 'citty'
import type { Result } from 'gscdump/result'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { defaultReportRegistry, dryRunReport, formatReport, runReport } from '@gscdump/analysis/report'
import { resolveWindow } from '@gscdump/engine/period'
import { defineCommand } from 'citty'
import { err, ok, unwrapResult } from 'gscdump/result'
import { resolveAnalysisSource } from '../analysis-local'
import { reportCommandMeta } from '../command-meta'
import { logger } from '../utils'

/**
 * Modelled, caller-actionable flag-parsing failures for the `report` command:
 * an unknown `--period` or `--vs` the user passed. `kind`-discriminated, paired
 * with `Result` so the `*Result` core can be unit-tested without `try`/`catch`.
 */
type ReportFlagError
  = | { kind: 'unknown-period', value: string, message: string }
    | { kind: 'unknown-comparison', value: string, message: string }

function reportFlagErrorToException(error: ReportFlagError): Error {
  const exception = new Error(error.message)
  ;(exception as Error & { reportFlagError?: ReportFlagError }).reportFlagError = error
  return exception
}

const REPORT_IDS = defaultReportRegistry.listReportIds()

const PERIOD_ALIASES: Record<string, WindowPreset> = {
  '7d': 'last-7d',
  '28d': 'last-28d',
  '30d': 'last-30d',
  '90d': 'last-90d',
  '180d': 'last-180d',
  '365d': 'last-365d',
  'last-7d': 'last-7d',
  'last-28d': 'last-28d',
  'last-30d': 'last-30d',
  'last-90d': 'last-90d',
  'last-180d': 'last-180d',
  'last-365d': 'last-365d',
  'mtd': 'mtd',
  'ytd': 'ytd',
  'custom': 'custom',
}

const COMPARISON_ALIASES: Record<string, ComparisonMode> = {
  'none': 'none',
  'prev': 'prev-period',
  'prev-period': 'prev-period',
  'prior': 'prev-period',
  'prior-period': 'prev-period',
  'yoy': 'yoy',
}

function resolvePeriodResult(input: string | undefined, fallback: WindowPreset): Result<WindowPreset, ReportFlagError> {
  if (!input)
    return ok(fallback)
  const preset = PERIOD_ALIASES[input.toLowerCase()]
  if (!preset)
    return err({ kind: 'unknown-period', value: input, message: `Unknown --period "${input}". Supported: 7d, 28d, 30d, 90d, 180d, 365d, mtd, ytd, custom.` })
  return ok(preset)
}

function resolvePeriod(input: string | undefined, fallback: WindowPreset): WindowPreset {
  return unwrapResult(resolvePeriodResult(input, fallback), reportFlagErrorToException)
}

function resolveComparisonResult(input: string | undefined, fallback: ComparisonMode): Result<ComparisonMode, ReportFlagError> {
  if (!input)
    return ok(fallback)
  const mode = COMPARISON_ALIASES[input.toLowerCase()]
  if (!mode)
    return err({ kind: 'unknown-comparison', value: input, message: `Unknown --vs "${input}". Supported: none, prev-period, yoy.` })
  return ok(mode)
}

function resolveComparison(input: string | undefined, fallback: ComparisonMode): ComparisonMode {
  return unwrapResult(resolveComparisonResult(input, fallback), reportFlagErrorToException)
}

function reportArgsToCitty(spec: ReportArgsSpec): Record<string, { type: 'string' | 'boolean', description?: string, default?: unknown, alias?: string, required?: boolean }> {
  // citty doesn't support type: 'number' — numeric flags must be declared as
  // 'string' and coerced later. Otherwise citty silently drops every arg.
  const out: Record<string, { type: 'string' | 'boolean', description?: string, default?: unknown, alias?: string, required?: boolean }> = {}
  for (const [key, def] of Object.entries(spec)) {
    out[key] = {
      type: def.type === 'boolean' ? 'boolean' : 'string',
      description: def.description,
      default: def.default == null ? undefined : String(def.default),
      alias: def.alias,
      required: def.required,
    }
  }
  return out
}

function buildReportParams(report: DefinedReport, args: Record<string, unknown>): ReportParams {
  const params: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(report.argsSpec)) {
    const raw = args[key]
    if (raw == null || raw === '')
      continue
    if (def.type === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n))
        params[toCamel(key)] = n
    }
    else if (def.type === 'boolean') {
      params[toCamel(key)] = !!raw
    }
    else {
      params[toCamel(key)] = raw
    }
  }
  return params
}

function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function makeReportCommand(report: DefinedReport): CommandDef<any> {
  const reportArgs = reportArgsToCitty(report.argsSpec)
  return defineCommand({
    meta: {
      name: report.id,
      description: report.description,
    },
    args: {
      'site': { type: 'string', alias: 's', description: 'Site URL' },
      'period': { type: 'string', description: 'Window: 7d|28d|90d|mtd|ytd|custom', default: presetToFlag(report.defaultPeriod) },
      'vs': { type: 'string', description: 'Comparison: none|prev-period|yoy', default: report.defaultComparison },
      'start': { type: 'string', description: 'Custom start date (YYYY-MM-DD)' },
      'end': { type: 'string', description: 'Custom end date (YYYY-MM-DD)' },
      'prev-start': { type: 'string', description: 'Override comparison start' },
      'prev-end': { type: 'string', description: 'Override comparison end' },
      'live': { type: 'boolean', default: false, description: 'Force live GSC API; bypass local store' },
      'json': { type: 'boolean', default: false, description: 'Emit full ReportResult JSON' },
      'explain': { type: 'boolean', default: false, description: 'Print plan steps + window without executing' },
      'dry-run': { type: 'boolean', default: false, description: 'Alias for --explain' },
      ...reportArgs,
    },
    async run({ args }) {
      const preset = resolvePeriod(args.period as string | undefined, report.defaultPeriod)
      const comparison = resolveComparison(args.vs as string | undefined, report.defaultComparison)

      const window = resolveWindow({
        preset,
        comparison,
        start: args.start as string | undefined,
        end: args.end as string | undefined,
      })

      if (args['prev-start'] && args['prev-end']) {
        window.comparison = {
          start: String(args['prev-start']),
          end: String(args['prev-end']),
        }
      }

      const params = buildReportParams(report, args)

      if (args.explain || args['dry-run']) {
        const ctx: ReportContext = { site: args.site ? String(args.site) : '(unresolved)', window, params, registryVersion: defaultReportRegistry.version }
        const dry = await dryRunReport(report, ctx)
        console.log(JSON.stringify({ id: report.id, window, comparison, plan: dry.steps }, null, 2))
        return
      }

      const { source, siteUrl } = await resolveAnalysisSource({
        site: args.site,
        live: !!args.live,
        json: !!args.json,
      })

      const ctx: ReportContext = { site: siteUrl, window, params, registryVersion: defaultReportRegistry.version }
      const result = await runReport(report, { source, analyzers: defaultAnalyzerRegistry, ctx })

      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      console.log(formatReport(result))
      if (result.meta.degraded)
        logger.warn(`degraded: ${result.meta.steps.filter(s => s.status === 'error').map(s => `${s.key}(${s.error})`).join(', ')}`)
    },
  })
}

function presetToFlag(preset: WindowPreset): string {
  if (preset === 'mtd' || preset === 'ytd' || preset === 'custom')
    return preset
  return preset.replace(/^last-/, '')
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List available report ids',
  },
  args: {
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const reports = defaultReportRegistry.listReports().map(r => ({
      id: r.id,
      description: r.description,
      defaultPeriod: r.defaultPeriod,
      defaultComparison: r.defaultComparison,
    }))
    if (args.json) {
      console.log(JSON.stringify(reports, null, 2))
      return
    }
    for (const r of reports)
      console.log(`${r.id.padEnd(16)} ${r.description}`)
  },
})

export const reportCommand = defineCommand({
  meta: reportCommandMeta,
  subCommands: {
    list: listCommand,
    ...Object.fromEntries(
      REPORT_IDS.map(id => [id, makeReportCommand(defaultReportRegistry.getReport(id)!)]),
    ),
  },
})
