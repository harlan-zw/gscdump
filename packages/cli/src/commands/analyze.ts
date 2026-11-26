import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { CommandDef } from 'citty'
import type { TableName } from '../local-store'
import {
  clusterQueryEmbeddings,
  DEFAULT_SEMANTIC_THRESHOLD,
  MOVERS_SORT_METRICS,
  normalizeQuery,
  NORMALIZER_VERSION,
  TRAJECTORY_DEFAULT_DAYS,
} from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { DEFAULT_FETCH_BUDGET, MAX_FETCH_BUDGET, num } from '@gscdump/engine/analysis-types'
import { createQueryEmbeddingsStore, dequantizeEmbeddingInt8 } from '@gscdump/engine/entities'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { defineCommand } from 'citty'
import { getLatestGscDate } from 'gscdump/dates'
import { unwrapResult } from 'gscdump/result'
import { analysisNeeds, analyzerTables, resolveAnalysisSource } from '../analysis-local'
import { analyzeCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { ANALYZER_DISPLAY, coverageWarning, renderAnalysis } from '../render/analysis'
import { terminalOutputOptions } from '../render/terminal'
import { readSiteStates } from '../route'
import { logger, parseFetchBudget, parseIntegerOption, setJsonOutput, toCSV } from '../utils'
import { DEFAULT_WINDOW, newestDoneDate, parseWindowFlags, PERIOD_FLAGS, windowFlagErrorToException } from '../window'

const ANALYSIS_TOOLS = defaultAnalyzerRegistry.listAnalyzerIds()

type AnalysisTool = string

// Tool-specific args and body builder
const COMPARISON_ARGS = {
  'prev-start': { type: 'string', description: 'Previous period start date (default: the period before the window)' },
  'prev-end': { type: 'string', description: 'Previous period end date (pass with --prev-start)' },
}

/** Analyzers that compare the window with a previous period. */
const COMPARISON_TOOLS = new Set<AnalysisTool>(['movers', 'decay'])

/** Analyzers that read `params.minImpressions`. */
const MIN_IMPRESSIONS_TOOLS = new Set<AnalysisTool>([
  'bayesian-ctr',
  'bipartite-pagerank',
  'brand',
  'cannibalization',
  'change-point',
  'clustering',
  'ctr-anomaly',
  'intent-atlas',
  'long-tail',
  'movers',
  'opportunity',
  'position-volatility',
  'query-migration',
  'stl-decompose',
  'striking-distance',
  'survival',
  'trends',
  'zero-click',
])

/** Analyzers that support `params.canonical` query folding. */
const CANONICAL_TOOLS = new Set<AnalysisTool>(['cannibalization', 'clustering', 'intent-atlas'])

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

  if (args['min-impressions'] !== undefined) {
    if (!MIN_IMPRESSIONS_TOOLS.has(tool))
      throw new Error(`--min-impressions is not supported by ${tool}.`)
    const minImpressions = parseIntegerOption(args['min-impressions'], '--min-impressions', 0)
    if (minImpressions !== undefined)
      params.minImpressions = minImpressions
  }

  if (args.canonical) {
    if (!CANONICAL_TOOLS.has(tool))
      throw new Error(`--canonical is not supported by ${tool}.`)
    params.canonical = true
  }

  if (args.fuzzy) {
    if (!CANONICAL_TOOLS.has(tool))
      throw new Error(`--fuzzy is not supported by ${tool}.`)
    params.fuzzy = true
  }

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
  // The trajectory reads the whole record by default, not the 28 day window.
  if (tool === 'trajectory' && !optional('period') && !optional('start')) {
    const endDate = optional('end') ?? anchor
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || Number.isNaN(Date.parse(`${endDate}T00:00:00Z`)))
      throw new Error(`Invalid --end "${endDate}". Use YYYY-MM-DD.`)
    const start = new Date(Date.parse(`${endDate}T00:00:00Z`) - (TRAJECTORY_DEFAULT_DAYS - 1) * 86_400_000)
    return { ...params, startDate: start.toISOString().slice(0, 10), endDate }
  }
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
  const extraArgs: Record<string, { type: string, description: string, alias?: string, default?: unknown }> = {
    ...(MIN_IMPRESSIONS_TOOLS.has(tool)
      ? { 'min-impressions': { type: 'string', description: 'Minimum impressions floor (analyzer default when omitted)' } }
      : {}),
    ...(CANONICAL_TOOLS.has(tool)
      ? {
          canonical: { type: 'boolean', default: false, description: 'Fold near-duplicate query variants via normalizeQuery before grouping' },
          fuzzy: { type: 'boolean', default: false, description: 'Fold typo and spacing variants after canonical normalization (implies --canonical)' },
        }
      : {}),
    ...(TOOL_EXTRA_ARGS[tool] || {}),
  }

  return defineCommand({
    meta: {
      name: tool,
      description: ANALYZER_DISPLAY[tool]?.description ?? `Run ${tool} analysis`,
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
      setJsonOutput(format === 'json')
      const { runAnalysis, siteUrl, anchor } = await resolveAnalysisSource({
        site: args.site,
        live: !!args.live,
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
      console.log(ANALYZER_DISPLAY[id] ? `${id}: ${ANALYZER_DISPLAY[id].description}` : id)
  },
})

const semanticClustersCommand = defineCommand({
  meta: {
    name: 'semantic-clusters',
    description: ANALYZER_DISPLAY['semantic-clusters']?.description ?? 'Cluster queries with deterministic UPGMA over stored query_embeddings',
  },
  args: {
    'site': { type: 'string', alias: 's', description: 'Site URL' },
    'period': { type: 'string', description: `Window: ${PERIOD_FLAGS.join('|')} (default: 28d, ending on the newest synced day)` },
    'start': { type: 'string', description: 'Start date (YYYY-MM-DD). Implies --period custom' },
    'end': { type: 'string', description: 'End date (YYYY-MM-DD). Implies --period custom' },
    'min-impressions': { type: 'string', default: '10', description: 'Minimum impressions floor per query (default: 10)' },
    'min-cluster-size': { type: 'string', default: '2', description: 'Minimum queries per cluster (default: 2)' },
    'threshold': { type: 'string', default: String(DEFAULT_SEMANTIC_THRESHOLD), description: `Average-linkage cosine similarity threshold in 0.5..0.99 (default: ${DEFAULT_SEMANTIC_THRESHOLD})` },
    'limit': { type: 'string', alias: 'l', default: '100', description: 'Max clusters to return' },
    'format': { type: 'string', alias: 'f', default: 'table', description: 'Output: table, json, csv' },
    'json': { type: 'boolean', default: false, description: 'Output as JSON' },
    'live': { type: 'boolean', default: false, description: 'Unsupported (semantic-clusters requires a local Store)' },
  },
  async run({ args }) {
    if (args.live)
      throw new Error('semantic-clusters requires a local Store with a query_embeddings sidecar; --live is not supported.')
    if (!args.json && !['table', 'json', 'csv'].includes(args.format ?? 'table'))
      throw new Error('Invalid --format. Use table, json, or csv.')
    const minImpressions = parseIntegerOption(args['min-impressions'], '--min-impressions', 0) ?? 10
    const minClusterSize = parseIntegerOption(args['min-cluster-size'], '--min-cluster-size', 1) ?? 2
    if (minClusterSize < 2)
      throw new Error(`Invalid --min-cluster-size "${String(args['min-cluster-size'])}". Use an integer >= 2.`)
    const limit = parseIntegerOption(args.limit, '--limit', 1) ?? 100
    const threshold = Number(args.threshold ?? DEFAULT_SEMANTIC_THRESHOLD)
    if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99)
      throw new Error(`Invalid --threshold "${String(args.threshold)}". Use a number between 0.5 and 0.99.`)

    const format = args.json ? 'json' : String(args.format ?? 'table')
    setJsonOutput(format === 'json')

    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined, { scope: 'store' })
    const siteId = store.siteIdFor(siteUrl)
    const tenantCtx = { userId: store.userId, siteId }

    const embeddingsStore = createQueryEmbeddingsStore({ dataSource: store.dataSource })
    const embMeta = await embeddingsStore.loadMeta(tenantCtx)
    if (!embMeta || embMeta.rowCount === 0)
      throw new Error(`No query_embeddings sidecar found for ${siteUrl}. Run: gscdump entities embeddings build --site ${siteUrl}`)
    if (embMeta.normalizerVersion !== NORMALIZER_VERSION) {
      throw new Error(
        `Stored query_embeddings sidecar for ${siteUrl} uses normalizer v${embMeta.normalizerVersion}, but current normalizer is v${NORMALIZER_VERSION}. Run: gscdump entities embeddings build --site ${siteUrl} --force`,
      )
    }

    const entries = await store.engine.listLive({ userId: store.userId, siteId, table: 'queries' as TableName })
    if (entries.length === 0)
      throw new Error(`No local queries data for ${siteUrl}. Run: gscdump sync --site ${siteUrl}`)

    const states = await readSiteStates(store, siteUrl)
    const anchor = newestDoneDate(states, ['queries']) ?? getLatestGscDate()
    const optional = (key: string): string | undefined => args[key] ? String(args[key]) : undefined
    const window = unwrapResult(parseWindowFlags({
      period: optional('period'),
      start: optional('start'),
      end: optional('end'),
    }, { ...DEFAULT_WINDOW, comparison: 'none' }, anchor), windowFlagErrorToException)

    const { rows } = await store.engine.runSQL({
      ctx: tenantCtx,
      table: 'queries' as TableName,
      fileSets: { FILES: { table: 'queries' as TableName, partitions: enumeratePartitions(window.start, window.end) } },
      sql: `
        SELECT
          query,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.impressions} AS impressions,
          ${METRIC_EXPR.position} AS position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
          AND query IS NOT NULL AND query <> ''
        GROUP BY query
        HAVING SUM(impressions) >= ?
      `,
      params: [window.start, window.end, minImpressions],
    })

    const embRecords = await embeddingsStore.loadRecords(tenantCtx)
    const vectorsByCanonical = new Map<string, Float32Array>()
    for (const rec of embRecords)
      vectorsByCanonical.set(rec.query_canonical, dequantizeEmbeddingInt8(rec.vec_i8_b64, rec.scale, rec.dims))

    const clusterInputs: Array<{ query: string, canonical: string, impressions: number, clicks: number, position: number, vector: Float32Array }> = []
    let missingEmbeddings = 0
    for (const r of rows) {
      const query = String(r.query)
      const canonical = normalizeQuery(query) || query.trim()
      const vector = vectorsByCanonical.get(canonical)
      if (!vector) {
        missingEmbeddings++
        continue
      }
      clusterInputs.push({
        query,
        canonical,
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        position: num(r.position),
        vector,
      })
    }

    const clustered = clusterQueryEmbeddings(clusterInputs, {
      threshold,
      minClusterSize,
      limit,
      model: embMeta.model,
    })

    const result = {
      results: clustered.results as unknown as Record<string, unknown>[],
      meta: {
        ...clustered.meta,
        startDate: window.start,
        endDate: window.end,
        embeddedQueries: clusterInputs.length,
        missingEmbeddings,
      },
    }

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (format === 'csv') {
      console.log(toCSV(result.results, Object.keys(result.results[0] ?? {})))
      return
    }
    console.log(renderAnalysis(result, {
      id: 'semantic-clusters',
      site: siteUrl,
      start: window.start,
      end: window.end,
    }, terminalOutputOptions()))
  },
})

export const analyzeCommand = defineCommand({
  meta: analyzeCommandMeta,
  subCommands: {
    'list': listCommand,
    'semantic-clusters': semanticClustersCommand,
    ...Object.fromEntries(
      ANALYSIS_TOOLS.map((tool: string) => [tool, makeToolCommand(tool)]),
    ),
  },
})
