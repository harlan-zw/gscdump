import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { WindowPreset } from '@gscdump/engine/period'
import type { DefinedReport, ReportArgsSpec, ReportContext, ReportParams } from '@gscdump/engine/report'
import type { CommandDef } from 'citty'
import type { TableName } from '../local-store'
import type { WindowDefaults, WindowFlags } from '../window'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { defaultReportRegistry, dryRunReport, runReport } from '@gscdump/analysis/report'
import { DEFAULT_FETCH_BUDGET, MAX_FETCH_BUDGET } from '@gscdump/engine/analysis-types'
import { defineCommand } from 'citty'
import { getLatestGscDate } from 'gscdump/dates'
import { unwrapResult } from 'gscdump/result'
import { analyzerTables, resolveAnalysisSource } from '../analysis-local'
import { reportCommandMeta } from '../command-meta'
import { renderCliReport } from '../render/report'
import { terminalOutputOptions } from '../render/terminal'
import { logger, parseFetchBudget } from '../utils'
import { COMPARISON_FLAGS, parseWindowFlags, PERIOD_FLAGS, windowFlagErrorToException } from '../window'

const REPORT_IDS = defaultReportRegistry.listReportIds()

function reportDefaults(report: DefinedReport): WindowDefaults {
  if (report.defaultPeriod === 'custom')
    throw new Error(`Report "${report.id}" declares a custom default period. Declare a preset.`)
  return { preset: report.defaultPeriod, comparison: report.defaultComparison }
}

function windowFlags(args: Record<string, unknown>): WindowFlags {
  const optional = (key: string): string | undefined => args[key] ? String(args[key]) : undefined
  return {
    period: optional('period'),
    vs: optional('vs'),
    start: optional('start'),
    end: optional('end'),
    prevStart: optional('prev-start'),
    prevEnd: optional('prev-end'),
  }
}

/** Tables every step of `report` reads, for anchoring its window. */
function reportTables(report: DefinedReport, params: ReportParams, flags: WindowFlags): TableName[] {
  // Tables do not depend on dates, so any valid window plans them.
  const provisional = unwrapResult(parseWindowFlags(flags, reportDefaults(report), getLatestGscDate()), windowFlagErrorToException)
  const steps = report.plan(params, provisional)
  return [...new Set(steps.flatMap(step => analyzerTables({ ...step.params, type: step.type } as AnalysisParams)))]
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
      'period': { type: 'string', description: `Window: ${PERIOD_FLAGS.join('|')} (default: ${presetToFlag(report.defaultPeriod)}, ending on the newest synced day)` },
      'vs': { type: 'string', description: `Comparison: ${COMPARISON_FLAGS.join('|')} (default: ${report.defaultComparison}). yoy compares with the same weekdays 52 weeks earlier` },
      'start': { type: 'string', description: 'Custom start date (YYYY-MM-DD). Implies --period custom' },
      'end': { type: 'string', description: 'Custom end date (YYYY-MM-DD). Implies --period custom' },
      'prev-start': { type: 'string', description: 'Override comparison start (pass with --prev-end)' },
      'prev-end': { type: 'string', description: 'Override comparison end (pass with --prev-start)' },
      'fetch-budget': { type: 'string', description: `Max rows each live fetch reads (default: ${DEFAULT_FETCH_BUDGET}, max: ${MAX_FETCH_BUDGET})` },
      'live': { type: 'boolean', default: false, description: 'Force live GSC API; bypass local store' },
      'json': { type: 'boolean', default: false, description: 'Emit full ReportResult JSON' },
      'explain': { type: 'boolean', default: false, description: 'Print plan steps + window without executing' },
      'dry-run': { type: 'boolean', default: false, description: 'Alias for --explain' },
      ...reportArgs,
    },
    async run({ args }) {
      const flags = windowFlags(args)
      const params = buildReportParams(report, args)
      const fetchBudget = parseFetchBudget(args['fetch-budget'])

      if (args.explain || args['dry-run']) {
        const window = unwrapResult(parseWindowFlags(flags, reportDefaults(report), getLatestGscDate()), windowFlagErrorToException)
        const ctx: ReportContext = { site: args.site ? String(args.site) : '(unresolved)', window, params, registryVersion: defaultReportRegistry.version }
        const dry = await dryRunReport(report, ctx)
        console.log(JSON.stringify({ id: report.id, window, plan: dry.steps }, null, 2))
        return
      }

      const { source, siteUrl, anchorFor } = await resolveAnalysisSource({
        site: args.site,
        live: !!args.live,
        json: !!args.json,
      })
      const anchor = await anchorFor(reportTables(report, params, flags))
      const window = unwrapResult(parseWindowFlags(flags, reportDefaults(report), anchor), windowFlagErrorToException)

      const ctx: ReportContext = { site: siteUrl, window, params, registryVersion: defaultReportRegistry.version, ...(fetchBudget !== undefined ? { fetchBudget } : {}) }
      const result = await runReport(report, { source, analyzers: defaultAnalyzerRegistry, ctx })

      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      console.log(renderCliReport(result, terminalOutputOptions()))
      if (result.meta.degraded)
        logger.warn(`degraded: ${result.meta.steps.filter(s => s.status === 'error').map(s => `${s.key}(${s.error})`).join(', ')}`)
    },
  })
}

function presetToFlag(preset: WindowPreset): string {
  return /^last-\d+d$/.test(preset) ? preset.replace(/^last-/, '') : preset
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
