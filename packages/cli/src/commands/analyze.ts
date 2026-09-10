import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { CommandDef } from 'citty'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { periodOf } from '@gscdump/engine/period'
import { defineCommand } from 'citty'
import { resolveAnalysisSource } from '../analysis-local'
import { analyzeCommandMeta } from '../command-meta'
import { gscErrorHandler } from '../error-handler'
import { renderAnalysis } from '../render/analysis'
import { terminalOutputOptions } from '../render/terminal'
import { logger, parseIntegerOption, toCSV } from '../utils'

const ANALYSIS_TOOLS = defaultAnalyzerRegistry.listAnalyzerIds()

type AnalysisTool = string

// Tool-specific args and body builder
const TOOL_EXTRA_ARGS: Partial<Record<AnalysisTool, Record<string, { type: string, description: string, alias?: string }>>> = {
  brand: {
    'brand-terms': { type: 'string', description: 'Comma-separated brand terms (required)' },
  },
  movers: {
    'prev-start': { type: 'string', description: 'Previous period start date (required)' },
    'prev-end': { type: 'string', description: 'Previous period end date (required)' },
  },
  decay: {
    'prev-start': { type: 'string', description: 'Previous period start date (required)' },
    'prev-end': { type: 'string', description: 'Previous period end date (required)' },
  },
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
    startDate: args.start ? String(args.start) : undefined,
    endDate: args.end ? String(args.end) : undefined,
    limit: parseIntegerOption(args.limit, '--limit'),
  }

  if (args['brand-terms'])
    params.brandTerms = String(args['brand-terms']).split(',').map(t => t.trim()).filter(Boolean)

  if (args['prev-start'])
    params.prevStartDate = String(args['prev-start'])
  if (args['prev-end'])
    params.prevEndDate = String(args['prev-end'])

  if (args.dimension)
    params.dimension = String(args.dimension) as 'pages' | 'keywords'
  if (args.metric)
    params.metric = String(args.metric) as 'clicks' | 'impressions'
  if (args['cluster-by'])
    params.clusterBy = String(args['cluster-by']) as 'prefix' | 'intent' | 'both'
  const weeks = parseIntegerOption(args.weeks, '--weeks')
  const minWeeks = parseIntegerOption(args['min-weeks'], '--min-weeks')
  if (weeks !== undefined)
    params.weeks = weeks
  if (minWeeks !== undefined)
    params.minWeeksWithData = minWeeks

  return params
}

function makeToolCommand(tool: AnalysisTool): CommandDef<any> {
  const extraArgs = TOOL_EXTRA_ARGS[tool] || {}

  return defineCommand({
    meta: {
      name: tool,
      description: `Run ${tool} analysis`,
    },
    args: {
      site: { type: 'string', alias: 's', description: 'Site URL' },
      start: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      limit: { type: 'string', alias: 'l', default: '100', description: 'Max results' },
      format: { type: 'string', alias: 'f', default: 'table', description: 'Output: table, json, csv' },
      json: { type: 'boolean', default: false, description: 'Output as JSON' },
      live: { type: 'boolean', default: false, description: 'Force live GSC API; bypass local Parquet store' },
      ...extraArgs,
    },
    async run({ args }) {
      if (!args.json && !['table', 'json', 'csv'].includes(args.format ?? 'table'))
        throw new Error('Invalid --format. Use table, json, or csv.')
      const params = buildParams(tool, args)
      const { format, runAnalysis, siteUrl } = await resolveAnalysisSource({
        site: args.site,
        live: !!args.live,
        json: !!args.json,
        format: args.format,
      })

      logger.info(`Running ${tool} analysis...`)

      const result = await runAnalysis(params).catch(gscErrorHandler)

      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      if (format === 'csv') {
        console.log(toCSV(result.results, Object.keys(result.results[0] ?? {})))
        return
      }
      const period = periodOf(params)
      console.log(renderAnalysis(result, {
        id: tool,
        site: siteUrl,
        start: period.startDate,
        end: period.endDate,
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
