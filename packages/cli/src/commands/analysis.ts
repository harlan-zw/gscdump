import type { CloudAnalysisPostBody, CloudClient } from '../cloud'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { getCloudClient } from '../auth'
import { loadConfig } from '../config'
import { logger, toCSV } from '../utils'

const ANALYSIS_TOOLS = [
  'striking-distance',
  'opportunity',
  'movers',
  'decay',
  'zero-click',
  'brand',
  'cannibalization',
  'clustering',
  'concentration',
  'seasonality',
] as const

type AnalysisTool = typeof ANALYSIS_TOOLS[number]

async function resolveSiteId(cloud: CloudClient, siteUrl?: string): Promise<string> {
  const config = await loadConfig()
  const target = siteUrl || config.defaultSite

  const me = await cloud.me().catch((e: Error) => {
    logger.error(`Failed to fetch profile: ${e.message}`)
    process.exit(1)
  })

  if (me.sites.length === 0) {
    logger.error('No registered sites. Run gscdump register first.')
    process.exit(1)
  }

  const match = target
    ? me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
    : undefined

  if (match)
    return match.siteId

  if (me.sites.length === 1)
    return me.sites[0].siteId

  const selected = await select({
    message: 'Select a site',
    options: me.sites.map(s => ({ value: s.siteId, label: s.siteUrl })),
  })

  if (isCancel(selected)) {
    cancel('Cancelled')
    process.exit(0)
  }

  return selected as string
}

// Extract a flat results array + total from the varying response shapes
function extractResults(data: Record<string, unknown>): { results: Record<string, unknown>[], total: number } {
  // Direct results array (cannibalization, decay, striking-distance, opportunity, zero-click)
  if (Array.isArray(data.results))
    return { results: data.results, total: (data.meta as any)?.total ?? data.results.length }

  // Preset (keywords array)
  if (Array.isArray(data.keywords))
    return { results: data.keywords, total: data.totalCount as number ?? data.keywords.length }

  // Clustering (clusters array - flatten)
  if (Array.isArray(data.clusters)) {
    const clusters = data.clusters as Record<string, unknown>[]
    return { results: clusters, total: (data.meta as any)?.totalClusters ?? clusters.length }
  }

  // Movers (combine rising + declining)
  if (Array.isArray(data.rising)) {
    const rows = [
      ...(data.rising as Record<string, unknown>[]).map(r => ({ ...r, direction: 'rising' })),
      ...(data.declining as Record<string, unknown>[] || []).map(r => ({ ...r, direction: 'declining' })),
    ]
    return { results: rows, total: rows.length }
  }

  // Brand (combine brand + nonBrand)
  if (Array.isArray(data.brand)) {
    const rows = [
      ...(data.brand as Record<string, unknown>[]).map(r => ({ ...r, segment: 'brand' })),
      ...(data.nonBrand as Record<string, unknown>[] || []).map(r => ({ ...r, segment: 'non-brand' })),
    ]
    return { results: rows, total: rows.length }
  }

  // Seasonality (monthly breakdown as rows)
  if (Array.isArray(data.monthlyBreakdown))
    return { results: data.monthlyBreakdown as Record<string, unknown>[], total: (data.monthlyBreakdown as unknown[]).length }

  // Concentration (single summary object)
  if (data.giniCoefficient !== undefined) {
    const { meta: _m, ...rest } = data
    return { results: [rest], total: 1 }
  }

  return { results: [], total: 0 }
}

// Tool-specific args and body builder
const TOOL_EXTRA_ARGS: Partial<Record<AnalysisTool, Record<string, { type: string, description: string, alias?: string }>>> = {
  'brand': {
    'brand-terms': { type: 'string', description: 'Comma-separated brand terms (required)' },
  },
  'movers': {
    'prev-start': { type: 'string', description: 'Previous period start date (required)' },
    'prev-end': { type: 'string', description: 'Previous period end date (required)' },
  },
  'decay': {
    'prev-start': { type: 'string', description: 'Previous period start date (required)' },
    'prev-end': { type: 'string', description: 'Previous period end date (required)' },
  },
  'concentration': {
    dimension: { type: 'string', description: 'Dimension: pages or keywords (default: pages)' },
  },
  'seasonality': {
    metric: { type: 'string', description: 'Metric: clicks or impressions (default: clicks)' },
  },
  'clustering': {
    'cluster-by': { type: 'string', description: 'Cluster by: prefix, intent, or both (default: both)' },
  },
}

function buildBody(tool: AnalysisTool, args: Record<string, unknown>): CloudAnalysisPostBody {
  const body: CloudAnalysisPostBody = {
    type: tool,
    startDate: args.start ? String(args.start) : undefined,
    endDate: args.end ? String(args.end) : undefined,
    limit: args.limit ? Number(args.limit) : undefined,
  }

  if (args['brand-terms'])
    body.brandTerms = String(args['brand-terms']).split(',').map(t => t.trim()).filter(Boolean)

  if (args['prev-start'])
    body.prevStartDate = String(args['prev-start'])
  if (args['prev-end'])
    body.prevEndDate = String(args['prev-end'])

  if (args.dimension)
    body.dimension = String(args.dimension) as 'pages' | 'keywords'
  if (args.metric)
    body.metric = String(args.metric) as 'clicks' | 'impressions'
  if (args['cluster-by'])
    body.clusterBy = String(args['cluster-by']) as 'prefix' | 'intent' | 'both'

  return body
}

function makeToolCommand(tool: AnalysisTool) {
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
      ...extraArgs,
    },
    async run({ args }) {
      const cloud = await getCloudClient()
      if (!cloud) {
        logger.error('Analysis requires cloud mode. Run gscdump init to set up cloud mode.')
        process.exit(1)
      }

      const siteId = await resolveSiteId(cloud, args.site)

      logger.info(`Running ${tool} analysis...`)

      const body = buildBody(tool, args)
      const data = await cloud.analysisPost(siteId, body).catch((e: Error) => {
        logger.error(`Analysis failed: ${e.message}`)
        process.exit(1)
      })

      const format = args.json ? 'json' : String(args.format)

      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2))
        return
      }

      const { results, total } = extractResults(data)

      if (format === 'csv' && results.length > 0) {
        const cols = Object.keys(results[0])
        console.log(toCSV(results, cols))
        return
      }

      // Table output
      if (results.length === 0) {
        logger.warn('No results found')
        return
      }

      const cols = Object.keys(results[0])
      const widths = cols.map(c => Math.max(c.length, ...results.map(r => String(r[c] ?? '').length).slice(0, 20)))

      // Header
      console.log()
      console.log(`  ${cols.map((c, i) => c.padEnd(widths[i])).join('  ')}`)
      console.log(`  ${cols.map((_, i) => '─'.repeat(widths[i])).join('  ')}`)

      // Rows
      for (const row of results) {
        console.log(`  ${cols.map((c, i) => {
          const val = row[c]
          const str = typeof val === 'number' ? (Number.isInteger(val) ? String(val) : val.toFixed(2)) : String(val ?? '')
          return str.padEnd(widths[i])
        }).join('  ')}`)
      }

      console.log()
      logger.success(`${results.length} results`)
      if (total > results.length)
        logger.info(`Total: ${total} (showing ${results.length})`)
    },
  })
}

export const analysisCommand = defineCommand({
  meta: {
    name: 'analysis',
    description: 'SEO analysis tools (cloud mode only)',
  },
  subCommands: Object.fromEntries(
    ANALYSIS_TOOLS.map(tool => [tool, makeToolCommand(tool)]),
  ),
})
