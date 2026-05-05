import type { AnalysisParams } from '@gscdump/analysis'
import type { CommandDef } from 'citty'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { defineCommand } from 'citty'
import { resolveAnalysisSource } from '../analysis-local'
import { logger, toCSV } from '../utils'

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
    limit: args.limit ? Number(args.limit) : undefined,
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
  if (args.weeks)
    params.weeks = Number(args.weeks)
  if (args['min-weeks'])
    params.minWeeksWithData = Number(args['min-weeks'])

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
      const { format, runAnalysis } = await resolveAnalysisSource({
        site: args.site,
        live: !!args.live,
        json: !!args.json,
        format: args.format,
      })

      logger.info(`Running ${tool} analysis...`)

      const params = buildParams(tool, args)
      const result = await runAnalysis(params)

      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      renderResults(result.results, result.results.length, format)
    },
  })
}

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const SPARK_GAP = '·'

// Column rendering hints keyed by field name. Percentage semantics:
//   - ratio_to_pct : `growthRatio` style, 1.0 = no change → format as signed (v-1)*100%
//   - direct       : 0-1 ratio (share, ctr, declinePercent) → format as v*100%
//   - scaled       : already -100..+100 (clicksChangePercent) → format as signed %
const PERCENT_COLS: Record<string, 'ratio_to_pct' | 'direct' | 'scaled'> = {
  growthRatio: 'ratio_to_pct',
  brandShare: 'direct',
  topNConcentration: 'direct',
  declinePercent: 'direct',
  ctr: 'direct',
  share: 'direct',
  vsAverage: 'ratio_to_pct',
  clicksChangePercent: 'scaled',
  impressionsChangePercent: 'scaled',
}

type ColKind = 'series' | 'int' | 'float' | 'pct' | 'text'

function formatPct(val: number, style: 'ratio_to_pct' | 'direct' | 'scaled'): string {
  const pct = style === 'ratio_to_pct'
    ? (val - 1) * 100
    : style === 'direct' ? val * 100 : val
  if (!Number.isFinite(pct))
    return ''
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(0)}%`
}

function isTimeSeries(arr: unknown[]): arr is Array<Record<string, unknown>> {
  if (arr.length === 0)
    return false
  const first = arr[0]
  if (typeof first !== 'object' || first === null)
    return false
  const keys = Object.keys(first)
  const hasBucket = keys.includes('week') || keys.includes('date') || keys.includes('month')
  const hasMetric = keys.includes('clicks') || keys.includes('impressions') || keys.includes('value')
  return hasBucket && hasMetric
}

function pickBucketKey(first: Record<string, unknown>): string {
  if ('week' in first)
    return 'week'
  if ('date' in first)
    return 'date'
  return 'month'
}

function pickMetricKey(first: Record<string, unknown>): string {
  if ('clicks' in first)
    return 'clicks'
  if ('impressions' in first)
    return 'impressions'
  return 'value'
}

// Build time-aligned sparklines: every row renders against the union of bucket
// keys across all rows. Missing buckets render as `·` so the same column is the
// same week for every entity.
function computeAlignedSparklines(results: Record<string, unknown>[], col: string): string[] {
  const allBuckets = new Set<string>()
  const perRow: Array<Map<string, number> | null> = []
  let bucketKey = 'week'
  let metricKey = 'clicks'

  for (const r of results) {
    const arr = r[col]
    if (!Array.isArray(arr) || !isTimeSeries(arr)) {
      perRow.push(null)
      continue
    }
    const first = arr[0] as Record<string, unknown>
    bucketKey = pickBucketKey(first)
    metricKey = pickMetricKey(first)
    const m = new Map<string, number>()
    for (const item of arr) {
      const rec = item as Record<string, unknown>
      const key = String(rec[bucketKey])
      const val = Number(rec[metricKey] ?? 0)
      allBuckets.add(key)
      m.set(key, val)
    }
    perRow.push(m)
  }

  const sorted = [...allBuckets].sort()
  return perRow.map((m) => {
    if (!m)
      return ''
    const values: Array<number | null> = sorted.map(b => (m.has(b) ? m.get(b)! : null))
    const nonNull = values.filter((v): v is number => v != null)
    if (nonNull.length === 0)
      return SPARK_GAP.repeat(values.length)
    const min = Math.min(...nonNull)
    const max = Math.max(...nonNull)
    const range = max - min
    return values
      .map((v) => {
        if (v == null)
          return SPARK_GAP
        if (range === 0)
          return SPARK_CHARS[0]
        const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1))
        return SPARK_CHARS[idx]
      })
      .join('')
  })
}

function classifyCol(col: string, values: unknown[]): ColKind {
  const firstNonNull = values.find(v => v != null)
  if (firstNonNull == null)
    return 'text'
  if (Array.isArray(firstNonNull) && isTimeSeries(firstNonNull))
    return 'series'
  if (col in PERCENT_COLS && values.every(v => v == null || typeof v === 'number'))
    return 'pct'
  if (values.every(v => v == null || typeof v === 'number')) {
    return values.some(v => typeof v === 'number' && !Number.isInteger(v as number)) ? 'float' : 'int'
  }
  return 'text'
}

function formatCellKinded(val: unknown, col: string, kind: ColKind): string {
  if (val == null)
    return ''
  if (kind === 'int')
    return typeof val === 'number' ? String(val) : String(val)
  if (kind === 'float')
    return typeof val === 'number' ? val.toFixed(2) : String(val)
  if (kind === 'pct')
    return typeof val === 'number' ? formatPct(val, PERCENT_COLS[col]) : String(val)
  if (Array.isArray(val))
    return `[${val.length} item${val.length === 1 ? '' : 's'}]`
  if (typeof val === 'object')
    return JSON.stringify(val)
  return String(val)
}

// Detect "rows are the time series" shape (e.g., seasonality's monthlyBreakdown).
// Returns a footer sparkline so the table gets a year-at-a-glance trend line.
function computeRowSeriesSparkline(results: Record<string, unknown>[]): { spark: string, label: string } | null {
  if (results.length < 2)
    return null
  const first = results[0]
  const bucketKey = 'week' in first ? 'week' : 'date' in first ? 'date' : 'month' in first ? 'month' : null
  if (!bucketKey)
    return null
  const metricKey = 'value' in first ? 'value' : 'clicks' in first ? 'clicks' : 'impressions' in first ? 'impressions' : null
  if (!metricKey)
    return null
  for (const r of results) {
    if (!(bucketKey in r) || !(metricKey in r))
      return null
  }
  const sorted = [...results].sort((a, b) => String(a[bucketKey]).localeCompare(String(b[bucketKey])))
  const values = sorted.map(r => Number(r[metricKey] ?? 0))
  const nonNull = values.filter(v => Number.isFinite(v))
  if (nonNull.length === 0)
    return null
  const min = Math.min(...nonNull)
  const max = Math.max(...nonNull)
  const range = max - min
  const spark = values
    .map((v) => {
      if (range === 0)
        return SPARK_CHARS[0]
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1))
      return SPARK_CHARS[idx]
    })
    .join('')
  const label = `${results.length} ${bucketKey}${results.length === 1 ? '' : 's'} of ${metricKey}`
  return { spark, label }
}

function renderResults(results: Record<string, unknown>[], total: number, format: string): void {
  if (format === 'csv' && results.length > 0) {
    const cols = Object.keys(results[0])
    console.log(toCSV(results, cols))
    return
  }

  if (results.length === 0) {
    logger.warn('No results found')
    return
  }

  const cols = Object.keys(results[0])
  const kinds: ColKind[] = cols.map(c => classifyCol(c, results.map(r => r[c])))

  const sparklineByCol: Record<string, string[]> = {}
  cols.forEach((c, i) => {
    if (kinds[i] === 'series')
      sparklineByCol[c] = computeAlignedSparklines(results, c)
  })

  const cellText = (row: Record<string, unknown>, rowIdx: number, colIdx: number): string => {
    const c = cols[colIdx]
    const k = kinds[colIdx]
    if (k === 'series')
      return sparklineByCol[c][rowIdx]
    return formatCellKinded(row[c], c, k)
  }

  const widths = cols.map((c, i) => {
    let w = c.length
    const limit = Math.min(results.length, 20)
    for (let j = 0; j < limit; j++) {
      const len = cellText(results[j], j, i).length
      if (len > w)
        w = len
    }
    return w
  })

  console.log()
  console.log(`  ${cols.map((c, i) => c.padEnd(widths[i])).join('  ')}`)
  console.log(`  ${cols.map((_, i) => '─'.repeat(widths[i])).join('  ')}`)

  for (let r = 0; r < results.length; r++) {
    console.log(`  ${cols.map((_, i) => cellText(results[r], r, i).padEnd(widths[i])).join('  ')}`)
  }

  const rowSeriesSparkline = computeRowSeriesSparkline(results)
  if (rowSeriesSparkline) {
    console.log()
    console.log(`  trend: ${rowSeriesSparkline.spark}  (${rowSeriesSparkline.label})`)
  }

  console.log()
  logger.success(`${results.length} results`)
  if (total > results.length)
    logger.info(`Total: ${total} (showing ${results.length})`)
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
  meta: {
    name: 'analyze',
    description: 'SEO analysis tools',
  },
  subCommands: {
    list: listCommand,
    ...Object.fromEntries(
      ANALYSIS_TOOLS.map((tool: string) => [tool, makeToolCommand(tool)]),
    ),
  },
})
