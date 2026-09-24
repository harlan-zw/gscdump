import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { CommandDef } from 'citty'
import { MOVERS_SORT_METRICS } from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { DEFAULT_FETCH_BUDGET, MAX_FETCH_BUDGET } from '@gscdump/engine/analysis-types'
import { defineCommand } from 'citty'
import { unwrapResult } from 'gscdump/result'
import { analysisNeeds, analyzerTables, resolveAnalysisSource } from '../analysis-local'
import { analyzeCommandMeta } from '../command-meta'
import { coverageWarning, renderAnalysis } from '../render/analysis'
import { terminalOutputOptions } from '../render/terminal'
import { logger, parseFetchBudget, parseIntegerOption, toCSV } from '../utils'
import { DEFAULT_WINDOW, parseWindowFlags, PERIOD_FLAGS, windowFlagErrorToException } from '../window'

const ANALYSIS_TOOLS = defaultAnalyzerRegistry.listAnalyzerIds()

type AnalysisTool = string

// Tool-specific args and body builder
const COMPARISON_ARGS = {
  'prev-start': { type: 'string', description: 'Previous period start date (default: the period before the window)' },
  'prev-end': { type: 'string', description: 'Previous period end date (pass with --prev-start)' },
}

/** Analyzers that compare the window with a previous period. */
const COMPARISON_TOOLS = new Set<AnalysisTool>(['movers', 'decay'])

const TOOL_EXTRA_ARGS: Partial<Record<AnalysisTool, Record<string, { type: string, description: string, alias?: string }>>> = {
  brand: {
    'brand-terms': { type: 'string', description: 'Comma-separated brand terms (required)' },
  },
  movers: {
    ...COMPARISON_ARGS,
    'sort-by': { type: 'string', description: `Sort: ${MOVERS_SORT_METRICS.join(', ')} (default: clicksDelta)` },
  },
  decay: COMPARISON_ARGS,
  concentration: {
    dimension: { type: 'string', description: 'Dimension: pages or keywords (default: pages)' },
  },
  seasonality: {
    metric: { type: 'string', description: 'Metric: clicks or impressions (default: clicks)' },
  },
  clustering: {
    'cluster-by': { type: 'string', description: 'Cluster by: prefix, intent, or both (default: both)' },
  },
  trends: {
    'dimension': { type: 'string', description: 'Dimension: pages or keywords (default: pages)' },
    'weeks': { type: 'string', description: 'Rolling window size in weeks (default: 28)' },
    'min-weeks': { type: 'string', description: 'Minimum weeks with data to include an entity (default: weeks/4)' },
  },
}

function buildParams(tool: AnalysisTool, args: Record<string, unknown>): AnalysisParams {
  const params: AnalysisParams = {
    type: tool as AnalysisParams['type'],
    limit: parseIntegerOption(args.limit, '--limit'),
  }
  const fetchBudget = parseFetchBudget(args['fetch-budget'])
  if (fetchBudget !== undefined)
    params.fetchBudget = fetchBudget

  if (args['brand-terms'])
    params.brandTerms = String(args['brand-terms']).split(',').map(t => t.trim()).filter(Boolean)

  if (args.dimension)
    params.dimension = String(args.dimension) as 'pages' | 'keywords'
  if (args.metric)
    params.metric = String(args.metric) as 'clicks' | 'impressions'
  if (args['cluster-by'])
    params.clusterBy = String(args['cluster-by']) as 'prefix' | 'intent' | 'both'
  if (args['sort-by']) {
    const sortBy = String(args['sort-by'])
    if (!(MOVERS_SORT_METRICS as readonly string[]).includes(sortBy))
      throw new Error(`Invalid --sort-by "${sortBy}". Use one of: ${MOVERS_SORT_METRICS.join(', ')}.`)
    params.sortBy = sortBy
  }
  const weeks = parseIntegerOption(args.weeks, '--weeks')
  const minWeeks = parseIntegerOption(args['min-weeks'], '--min-weeks')
  if (weeks !== undefined)
    params.weeks = weeks
  if (minWeeks !== undefined)
    params.minWeeksWithData = minWeeks

  return params
}

/** Apply the window flags, anchored on `anchor`, to the analyzer params. */
function withWindow(tool: AnalysisTool, params: AnalysisParams, args: Record<string, unknown>, anchor: string): AnalysisParams {
  const optional = (key: string): string | undefined => args[key] ? String(args[key]) : undefined
  const window = unwrapResult(parseWindowFlags({
    period: optional('period'),
    start: optional('start'),
    end: optional('end'),
    prevStart: optional('prev-start'),
    prevEnd: optional('prev-end'),
  }, { ...DEFAULT_WINDOW, comparison: COMPARISON_TOOLS.has(tool) ? 'prev-period' : 'none' }, anchor), windowFlagErrorToException)
  return {
    ...params,
    startDate: window.start,
    endDate: window.end,
    ...(window.comparison ? { prevStartDate: window.comparison.start, prevEndDate: window.comparison.end } : {}),
  }
}

function makeToolCommand(tool: AnalysisTool): CommandDef<any> {
  const extraArgs = TOOL_EXTRA_ARGS[tool] || {}

  return defineCommand({
    meta: {
      name: tool,
      description: `Run ${tool} analysis`,
    },
    args: {
      'site': { type: 'string', alias: 's', description: 'Site URL' },
      'period': { type: 'string', description: `Window: ${PERIOD_FLAGS.join('|')} (default: 28d, ending on the newest synced day)` },
      'start': { type: 'string', description: 'Start date (YYYY-MM-DD). Implies --period custom' },
      'end': { type: 'string', description: 'End date (YYYY-MM-DD). Implies --period custom' },
      'limit': { type: 'string', alias: 'l', default: '100', description: 'Max results to return' },
      'fetch-budget': { type: 'string', description: `Max rows each live fetch reads (default: ${DEFAULT_FETCH_BUDGET}, max: ${MAX_FETCH_BUDGET})` },
      'format': { type: 'string', alias: 'f', default: 'table', description: 'Output: table, json, csv' },
      'json': { type: 'boolean', default: false, description: 'Output as JSON' },
      'live': { type: 'boolean', default: false, description: 'Force live GSC API; bypass local Parquet store' },
      ...extraArgs,
    },
    async run({ args }) {
      if (!args.json && !['table', 'json', 'csv'].includes(args.format ?? 'table'))
        throw new Error('Invalid --format. Use table, json, or csv.')
      const baseParams = buildParams(tool, args)
      const format = args.json ? 'json' : String(args.format ?? 'table')
      const { runAnalysis, siteUrl, anchor } = await resolveAnalysisSource({
        site: args.site,
        live: !!args.live,
        json: format === 'json',
        label: `analyze ${tool}`,
        types: [tool],
        anchorTables: analyzerTables(baseParams),
        needs: anchor => analysisNeeds(withWindow(tool, baseParams, args, anchor)),
      })
      const params = withWindow(tool, baseParams, args, anchor)

      logger.debug(`Running ${tool} analysis...`)

      const result = await runAnalysis(params)

      const warning = coverageWarning(result.meta.coverage)
      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2))
        if (warning)
          logger.warn(warning)
        return
      }

      if (format === 'csv') {
        console.log(toCSV(result.results, Object.keys(result.results[0] ?? {})))
        if (warning)
          logger.warn(warning)
        return
      }
      console.log(renderAnalysis(result, {
        id: tool,
        site: siteUrl,
        start: params.startDate!,
        end: params.endDate!,
        ...(params.prevStartDate && params.prevEndDate ? { previous: { start: params.prevStartDate, end: params.prevEndDate } } : {}),
        metric: params.metric,
      }, terminalOutputOptions()))
    },
  })
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List available analyzer ids',
  },
  args: {
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    if (args.json) {
      console.log(JSON.stringify(ANALYSIS_TOOLS, null, 2))
      return
    }
    for (const id of ANALYSIS_TOOLS)
      console.log(id)
  },
})

export const analyzeCommand = defineCommand({
  meta: analyzeCommandMeta,
  subCommands: {
    list: listCommand,
    ...Object.fromEntries(
      ANALYSIS_TOOLS.map((tool: string) => [tool, makeToolCommand(tool)]),
    ),
  },
})
