<script setup lang="ts">
// Two kinds of tabs:
//   - Raw (pages, queries): typed SQL against the attached parquet views.
//     Sortable, paginated, column-toggleable.
//   - Analyzer (striking-distance, opportunity, ...): routes through
//     `analyzeInBrowser` in the composable. No pagination (small result sets).

interface RawTab {
  kind: 'raw'
  id: 'pages' | 'queries'
  label: string
  table: 'pages' | 'keywords'
  dim: string // url | query
}

interface AnalyzerTab {
  kind: 'analyzer'
  id: string
  label: string
}

interface SemanticTab {
  kind: 'semantic'
  id: 'content-gap'
  label: string
}

interface ActionTab {
  kind: 'action'
  id: 'actions'
  label: string
}

const TABS: Array<RawTab | AnalyzerTab | SemanticTab | ActionTab> = [
  { kind: 'raw', id: 'pages', label: 'Pages', table: 'pages', dim: 'url' },
  { kind: 'raw', id: 'queries', label: 'Queries', table: 'keywords', dim: 'query' },
  { kind: 'analyzer', id: 'striking-distance', label: 'Striking distance' },
  { kind: 'analyzer', id: 'opportunity', label: 'Opportunity' },
  { kind: 'analyzer', id: 'clustering', label: 'Clustering' },
  { kind: 'analyzer', id: 'concentration', label: 'Concentration' },
  { kind: 'analyzer', id: 'seasonality', label: 'Seasonality' },
  { kind: 'analyzer', id: 'movers', label: 'Movers' },
  { kind: 'analyzer', id: 'brand', label: 'Brand' },
  { kind: 'analyzer', id: 'cannibalization', label: 'Cannibalization' },
  { kind: 'analyzer', id: 'ctr-anomaly', label: 'CTR anomaly' },
  { kind: 'analyzer', id: 'position-volatility', label: 'Volatility' },
  { kind: 'analyzer', id: 'long-tail', label: 'Long-tail' },
  { kind: 'analyzer', id: 'intent-atlas', label: 'Intent atlas' },
  { kind: 'analyzer', id: 'query-migration', label: 'Migration' },
  { kind: 'analyzer', id: 'bayesian-ctr', label: 'Bayesian CTR' },
  { kind: 'analyzer', id: 'stl-decompose', label: 'STL' },
  { kind: 'analyzer', id: 'change-point', label: 'Change points' },
  { kind: 'analyzer', id: 'bipartite-pagerank', label: 'PageRank' },
  { kind: 'analyzer', id: 'survival', label: 'Survival' },
  { kind: 'analyzer', id: 'content-velocity', label: 'Velocity' },
  { kind: 'analyzer', id: 'ctr-curve', label: 'CTR curve' },
  { kind: 'analyzer', id: 'dark-traffic', label: 'Dark traffic' },
  { kind: 'analyzer', id: 'device-gap', label: 'Device gap' },
  { kind: 'analyzer', id: 'keyword-breadth', label: 'Breadth' },
  { kind: 'analyzer', id: 'position-distribution', label: 'Position dist.' },
  { kind: 'analyzer', id: 'trends', label: 'Trends' },
  { kind: 'analyzer', id: 'zero-click', label: 'Zero-click' },
  { kind: 'semantic', id: 'content-gap', label: 'Content gaps ✨' },
  { kind: 'action', id: 'actions', label: 'Actions ⚡' },
]

const activeId = ref<string>('pages')
const activeTab = computed(() => TABS.find(t => t.id === activeId.value)!)

const route = useRoute()
const siteId = computed(() => String(route.params.id))

definePageMeta({ key: route => `site:${route.params.id}` })

const runner = useGscAnalyzer(siteId)
const { query, analyze, ready: isReady, error: bootError, timings: bootTimings } = runner
const contentGap = useContentGap()
const actionPriority = useActionPriority()
// Query-grained widgets fetch the site's trailing-28d anonymization rate so
// the banner surfaces how much of the total impression volume is missing.
const currentSite = useGscSite(siteId)
const { data: dailyPayload } = useGscRollup<{ impressions: number, anonymizedImpressionsPct: number }[]>(siteId, 'daily_totals')
const anonymizationPct = computed(() => weightedAnonPct(dailyPayload.value))

// Period state drives the raw-tab date filter + gets forwarded to analyzers
// as `dateStart` / `dateEnd`. Analyzers that accept those use them; others
// ignore unknown params.
type Period = typeof PERIOD_PRESETS[number]['value']
type CompareMode = typeof COMPARE_OPTIONS[number]['value']
const period = ref<Period>('28d')
const compareMode = ref<CompareMode>('previous')
const stableData = ref(true)
const dateRange = computed(() => periodToDateRange(period.value, { stableData: stableData.value }))

// Tabs whose data is query-grained (reads the `keywords` table). These
// widgets sum per-query rows and so silently drop GSC-anonymized impressions;
// we surface the dropped fraction so users don't compare them to page totals.
const QUERY_GRAINED_TABS = new Set<string>([
  'queries',
  'striking-distance',
  'opportunity',
  'clustering',
  'concentration',
  'movers',
  'brand',
  'cannibalization',
  'ctr-anomaly',
  'long-tail',
  'intent-atlas',
  'query-migration',
  'bayesian-ctr',
  'stl-decompose',
  'change-point',
  'bipartite-pagerank',
  'survival',
  'content-velocity',
  'ctr-curve',
  'keyword-breadth',
  'trends',
  'zero-click',
  'content-gap',
])
const showAnonymizationWarning = computed(() => QUERY_GRAINED_TABS.has(activeId.value))

// Metric column toggles (raw tabs only)
const METRIC_COLS = ['clicks', 'impressions', 'ctr', 'avg_position'] as const
type MetricCol = typeof METRIC_COLS[number]
const visibleMetrics = ref<Record<MetricCol, boolean>>({
  clicks: true,
  impressions: true,
  ctr: true,
  avg_position: true,
})

// Sort + pagination. `sort` applies universally: raw tabs push it into SQL
// when the column is a known metric or the row dim; analyzer tabs apply it
// client-side against the returned rows.
const RAW_SQL_SORT_COLS = ['clicks', 'impressions', 'ctr', 'avg_position'] as const

// URL-synced table state (search/sort/page deep-linking).
const { q: search, sort, page, pageSize } = useGscTableState({
  defaultSort: { column: 'clicks', direction: 'desc' },
})

// Fuzzy search (raw tabs only). Debounced to ~200ms so keystrokes don't each
// fire a query — the debounced signal is what watchers react to.
const searchDebounced = ref('')
let searchDebounceHandle: ReturnType<typeof setTimeout> | null = null
watch(search, (v) => {
  if (searchDebounceHandle)
    clearTimeout(searchDebounceHandle)
  searchDebounceHandle = setTimeout(() => {
    searchDebounced.value = v
  }, 200)
})

const WHITESPACE_RE = /\s+/
function searchTokens(s: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of s.trim().split(WHITESPACE_RE).filter(Boolean)) {
    const lower = t.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      out.push(lower)
    }
  }
  return out
}

const loading = ref(false)
const error = ref<string | null>(null)
const rows = ref<Record<string, unknown>[]>([])
const totalRows = ref<number | null>(null)
const queryMs = ref<number | null>(null)
const meta = ref<Record<string, unknown> | null>(null)

function rawSortKey(tab: RawTab): string {
  const col = sort.value?.column ?? 'clicks'
  if ((RAW_SQL_SORT_COLS as readonly string[]).includes(col))
    return col
  if (col === tab.dim)
    return tab.dim
  return 'clicks'
}

interface RawQuery {
  sql: string
  params: unknown[]
}

// Builds `WHERE` fuzzy-filter + matched-token ranking for the active search.
// Each whitespace token is OR-joined (typo tolerance on other tokens), and
// rows are ranked by how many tokens they contain before falling back to the
// user's chosen sort.
function buildSearchClauses(dim: string, tokens: string[]): {
  where: string
  rank: string
  params: unknown[]
} {
  if (tokens.length === 0)
    return { where: '', rank: '', params: [] }
  const patterns = tokens.map(t => `%${t}%`)
  const ors = tokens.map(() => `${dim} ILIKE ?`).join(' OR ')
  const cases = tokens.map(() => `(CASE WHEN ${dim} ILIKE ? THEN 1 ELSE 0 END)`).join(' + ')
  return {
    where: `WHERE (${ors})`,
    rank: `${cases} DESC,`,
    params: [...patterns, ...patterns],
  }
}

// Adds `date BETWEEN ? AND ?` to a search-derived WHERE. `searchWhere` is
// either `""` or `"WHERE (ors)"` from buildSearchClauses.
function withDateFilter(searchWhere: string, searchParams: unknown[]): { where: string, params: unknown[] } {
  const { start, end } = dateRange.value
  const dateClause = `date BETWEEN ? AND ?`
  const where = searchWhere
    ? `${searchWhere} AND ${dateClause}`
    : `WHERE ${dateClause}`
  return { where, params: [...searchParams, start, end] }
}

function buildSqlRaw(tab: RawTab): RawQuery {
  const dir = (sort.value?.direction ?? 'desc').toUpperCase()
  const limit = pageSize.value
  const offset = (page.value - 1) * pageSize.value
  const tokens = searchTokens(searchDebounced.value)
  const { where: searchWhere, rank, params: searchParams } = buildSearchClauses(tab.dim, tokens)
  const { where, params: whereParams } = withDateFilter(searchWhere, searchParams.slice(0, tokens.length))
  // Re-append the ORDER BY rank patterns (they weren't in searchParams.slice).
  const rankParams = searchParams.slice(tokens.length)
  const sql = `
    SELECT ${tab.dim},
           SUM(clicks)::BIGINT AS clicks,
           SUM(impressions)::BIGINT AS impressions,
           CASE WHEN SUM(impressions) > 0
                THEN ROUND(SUM(clicks) * 1.0 / SUM(impressions), 4)
                ELSE 0 END AS ctr,
           CASE WHEN SUM(impressions) > 0
                THEN ROUND(SUM(sum_position) / SUM(impressions) + 1, 2)
                ELSE 0 END AS avg_position
    FROM main.${tab.table}
    ${where}
    GROUP BY ${tab.dim}
    ORDER BY ${rank} ${rawSortKey(tab)} ${dir}
    LIMIT ${limit} OFFSET ${offset}
  `
  return { sql, params: [...whereParams, ...rankParams] }
}

function buildCountSql(tab: RawTab): RawQuery {
  const tokens = searchTokens(searchDebounced.value)
  const { where: searchWhere, params: searchParams } = buildSearchClauses(tab.dim, tokens)
  // Rank params aren't used here; strip the ORDER BY half.
  const countParams = searchParams.slice(0, tokens.length)
  const { where, params } = withDateFilter(searchWhere, countParams)
  return {
    sql: `SELECT COUNT(DISTINCT ${tab.dim})::BIGINT AS n FROM main.${tab.table} ${where}`,
    params,
  }
}

async function runActive(): Promise<void> {
  // Semantic + action tabs manage their own lifecycle.
  if (activeTab.value.kind === 'semantic' || activeTab.value.kind === 'action')
    return
  loading.value = true
  error.value = null
  rows.value = []
  meta.value = null
  queryMs.value = null
  try {
    if (activeTab.value.kind === 'raw') {
      const tab = activeTab.value
      // Fire count + page in parallel — they hit the same warm DuckDB connection.
      const pageQ = buildSqlRaw(tab)
      const countQ = buildCountSql(tab)
      const [pageRes, countRes] = await Promise.all([
        query(pageQ.sql, pageQ.params),
        query(countQ.sql, countQ.params),
      ])
      rows.value = pageRes.rows
      queryMs.value = pageRes.queryMs
      const n = countRes.rows[0]?.n
      totalRows.value = typeof n === 'bigint' ? Number(n) : typeof n === 'number' ? n : null
    }
    else {
      totalRows.value = null
      // Analyzers that accept a window (movers, trends, change-point, …) pick
      // up `dateStart` / `dateEnd`; ones that don't ignore unknown params.
      const { start, end } = dateRange.value
      const r = await analyze({
        type: activeTab.value.id,
        dateStart: start,
        dateEnd: end,
      } as never)
      rows.value = r.results
      meta.value = r.meta
      queryMs.value = r.queryMs
    }
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

// Reset pagination + clear search when tab changes. Layer auto-resets `page`
// when `q` changes, so we only need to clear `search` here.
watch(activeId, () => {
  page.value = 1
  search.value = ''
  searchDebounced.value = ''
})

// Re-run when anything query-affecting changes (after boot).
watch(
  [activeId, sort, pageSize, page, searchDebounced, period, stableData, isReady],
  (_, __, onCleanup) => {
    if (!isReady.value)
      return
    void runActive()
    onCleanup(() => {})
  },
)

function isSortable(col: string): boolean {
  const sample = rows.value[0]?.[col]
  if (Array.isArray(sample) || (sample !== null && typeof sample === 'object'))
    return false
  return true
}

function toggleSort(col: string): void {
  if (!isSortable(col))
    return
  const cur = sort.value
  if (cur && cur.column === col) {
    sort.value = { column: col, direction: cur.direction === 'desc' ? 'asc' : 'desc' }
  }
  else {
    const sample = rows.value[0]?.[col]
    const isNumeric = typeof sample === 'number' || typeof sample === 'bigint'
    sort.value = { column: col, direction: isNumeric ? 'desc' : 'asc' }
  }
  if (activeTab.value.kind === 'raw')
    page.value = 1
}

function compareCell(a: unknown, b: unknown): number {
  if (a == null && b == null)
    return 0
  if (a == null)
    return -1
  if (b == null)
    return 1
  if (typeof a === 'number' && typeof b === 'number')
    return a - b
  if (typeof a === 'bigint' && typeof b === 'bigint')
    return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' && typeof b === 'boolean')
    return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

// Raw tabs already return SQL-sorted + paginated rows; analyzer tabs return
// the analyzer's native order, so client-side sort is applied here.
const displayRows = computed(() => {
  if (activeTab.value.kind === 'raw')
    return rows.value
  if (!sort.value || !rows.value.length)
    return rows.value
  const key = sort.value.column
  const dir = sort.value.direction === 'desc' ? -1 : 1
  return [...rows.value].sort((ra, rb) => dir * compareCell(ra[key], rb[key]))
})

const visibleColumns = computed(() => {
  if (rows.value[0] == null)
    return []
  return Object.keys(rows.value[0]).filter((c) => {
    if (!METRIC_COLS.includes(c as MetricCol))
      return true
    return visibleMetrics.value[c as MetricCol]
  })
})

interface CannibalGraph {
  nodes: Array<{ url: string, impressions: number, clicks: number, queryCount: number }>
  edges: Array<{ source: string, target: string, weight: number, queries: number }>
}
interface CannibalEvent {
  keyword: string
  competitors: Array<{ url: string, rank: number }>
  severity: number
}

const cannibalGraph = computed<CannibalGraph | null>(() => {
  if (activeId.value !== 'cannibalization' || meta.value == null)
    return null
  return (meta.value.graph as CannibalGraph | undefined) ?? null
})

const cannibalEvents = computed<CannibalEvent[]>(() => {
  if (activeId.value !== 'cannibalization')
    return []
  return rows.value as unknown as CannibalEvent[]
})

interface AnomalySeriesPoint {
  date: string
  ctr: number
  rollingCtr: number | null
  rollingStddev: number | null
  z: number
  breach: boolean
  impressions: number
  position: number
}
interface AnomalyRow {
  keyword: string
  page: string
  breachDaysDown: number
  breachDaysUp: number
  clicksLost: number
  maxZ: number
  baselineCtr: number
  baselinePosition: number
  totalImpressions: number
  totalClicks: number
  series: AnomalySeriesPoint[]
}

const anomalies = computed<AnomalyRow[]>(() => {
  if (activeId.value !== 'ctr-anomaly')
    return []
  return rows.value as unknown as AnomalyRow[]
})

interface VolatilityDay {
  date: string
  queryCount: number
  dayImpressions: number
  avgPosition: number
  posStddev: number
  bestPosition: number
  worstPosition: number
  dodShift: number
  volatility: number
}
interface VolatilityPage {
  page: string
  avgVolatility: number
  peakVolatility: number
  totalImpressions: number
  days: VolatilityDay[]
}

const volatilityPages = computed<VolatilityPage[]>(() => {
  if (activeId.value !== 'position-volatility')
    return []
  return rows.value as unknown as VolatilityPage[]
})

const volatilityMeta = computed(() => {
  if (activeId.value !== 'position-volatility' || meta.value == null)
    return null
  return {
    dates: (meta.value.dates as string[] | undefined) ?? [],
    maxVolatility: typeof meta.value.maxVolatility === 'number' ? meta.value.maxVolatility : 0,
  }
})

interface LongTailRow {
  page: string
  queryCount: number
  totalImpressions: number
  totalClicks: number
  slope: number
  intercept: number
  r2: number
  headImpressions: number
  headShare: number
  fingerprint: 'flat-tail' | 'balanced' | 'head-heavy'
  points: Array<{ rank: number, impressions: number, clicks: number, query: string }>
}

const longTailPages = computed<LongTailRow[]>(() => {
  if (activeId.value !== 'long-tail')
    return []
  return rows.value as unknown as LongTailRow[]
})

const longTailSummary = computed(() => {
  if (activeId.value !== 'long-tail' || meta.value == null)
    return null
  const fp = meta.value.fingerprints as Record<string, number> | undefined
  return {
    counts: fp ?? { 'flat-tail': 0, 'balanced': 0, 'head-heavy': 0 },
    avgSlope: typeof meta.value.avgSlope === 'number' ? meta.value.avgSlope : 0,
  }
})

interface IntentCluster {
  clusterKey: string
  keywordCount: number
  totalImpressions: number
  totalClicks: number
  ctr: number
  avgPosition: number
  keywords: Array<{ query: string, impressions: number, position: number }>
}

const intentClusters = computed<IntentCluster[]>(() => {
  if (activeId.value !== 'intent-atlas')
    return []
  return rows.value as unknown as IntentCluster[]
})

const intentSummary = computed(() => {
  if (activeId.value !== 'intent-atlas' || meta.value == null)
    return null
  return {
    totalKeywords: typeof meta.value.totalKeywords === 'number' ? meta.value.totalKeywords : 0,
    totalImpressions: typeof meta.value.totalImpressions === 'number' ? meta.value.totalImpressions : 0,
  }
})

interface MigrationEdge {
  sourcePage: string
  targetPage: string
  weight: number
  queryCount: number
  exactCount: number
  fuzzyCount: number
  examples: Array<{ sourceQuery: string, targetQuery: string, absorbed: number, matchType: 'exact' | 'fuzzy' }>
}
interface MigrationNode { url: string, outgoing: number, incoming: number }

const migrationEdges = computed<MigrationEdge[]>(() => {
  if (activeId.value !== 'query-migration')
    return []
  return rows.value as unknown as MigrationEdge[]
})

const migrationMeta = computed(() => {
  if (activeId.value !== 'query-migration' || meta.value == null)
    return null
  return {
    nodes: (meta.value.nodes as MigrationNode[] | undefined) ?? [],
    totalAbsorbed: typeof meta.value.totalAbsorbed === 'number' ? meta.value.totalAbsorbed : 0,
    period: meta.value.period as { current: { startDate: string, endDate: string }, previous: { startDate: string, endDate: string } } | undefined,
  }
})

interface BayesianCtrRow {
  keyword: string
  page: string
  clicks: number
  impressions: number
  observedCtr: number
  position: number
  bucket: number
  priorAlpha: number
  priorBeta: number
  bucketPriorMean: number
  posteriorMean: number
  posteriorSd: number
  ciLow: number
  ciHigh: number
  shrinkageDelta: number
  expectedClicksDelta: number
  significance: number
  classification: 'overperforming' | 'underperforming' | 'expected'
}

const bayesianRows = computed<BayesianCtrRow[]>(() => {
  if (activeId.value !== 'bayesian-ctr')
    return []
  return rows.value as unknown as BayesianCtrRow[]
})

const bayesianSummary = computed(() => {
  if (activeId.value !== 'bayesian-ctr' || bayesianRows.value.length === 0)
    return null
  const under = bayesianRows.value.filter(r => r.classification === 'underperforming').length
  const over = bayesianRows.value.filter(r => r.classification === 'overperforming').length
  const expectedClicksGap = bayesianRows.value.reduce((s, r) => s + r.expectedClicksDelta, 0)
  return { under, over, expectedClicksGap }
})

interface StlEntity {
  keyword: string
  page: string
  totalImpressions: number
  days: number
  seasonalStrength: number
  trendStrength: number
  residualAnomalies: number
  trendSlope: number
  series: Array<{
    date: string
    observed: number
    trend: number | null
    seasonal: number | null
    residual: number | null
    anomaly: boolean
  }>
}

const stlEntities = computed<StlEntity[]>(() => {
  if (activeId.value !== 'stl-decompose')
    return []
  return rows.value as unknown as StlEntity[]
})

interface ChangePointEntity {
  keyword: string
  page: string
  totalDays: number
  changeDate: string
  llr: number
  leftMean: number
  rightMean: number
  delta: number
  leftStddev: number
  rightStddev: number
  direction: 'improved' | 'worsened'
  series: Array<{ date: string, value: number }>
}

const changePointEntities = computed<ChangePointEntity[]>(() => {
  if (activeId.value !== 'change-point')
    return []
  return rows.value as unknown as ChangePointEntity[]
})

interface PageRankNode {
  kind: 'query' | 'url'
  id: string
  rank: number
  bridging: number
  anchoring: number
  degree: number
  impressions: number
}

const pageRankNodes = computed<PageRankNode[]>(() => {
  if (activeId.value !== 'bipartite-pagerank')
    return []
  return rows.value as unknown as PageRankNode[]
})

const pageRankMeta = computed(() => {
  if (activeId.value !== 'bipartite-pagerank' || meta.value == null)
    return null
  return {
    iterations: typeof meta.value.iterations === 'number' ? meta.value.iterations : 25,
    damping: typeof meta.value.damping === 'number' ? meta.value.damping : 0.85,
    convergenceDelta: typeof meta.value.convergenceDelta === 'number' ? meta.value.convergenceDelta : 0,
    queryCount: typeof meta.value.queryCount === 'number' ? meta.value.queryCount : 0,
    urlCount: typeof meta.value.urlCount === 'number' ? meta.value.urlCount : 0,
    deltas: (meta.value.deltas as Array<{ step: number, l1: number }> | undefined) ?? [],
  }
})

interface SurvivalCurvePoint { tenure: number, survival: number, atRisk: number, events: number }
interface SurvivalCohort {
  cohort: string
  episodeCount: number
  censoringRate: number
  medianTenure: number
  curve: SurvivalCurvePoint[]
}

const survivalCohorts = computed<SurvivalCohort[]>(() => {
  if (activeId.value !== 'survival')
    return []
  return rows.value as unknown as SurvivalCohort[]
})

const survivalMeta = computed(() => {
  if (activeId.value !== 'survival' || meta.value == null)
    return null
  return {
    totalEpisodes: typeof meta.value.totalEpisodes === 'number' ? meta.value.totalEpisodes : 0,
    cohortCount: typeof meta.value.cohortCount === 'number' ? meta.value.cohortCount : 0,
    windowDays: typeof meta.value.windowDays === 'number' ? meta.value.windowDays : 180,
  }
})

const anomalySummary = computed(() => {
  if (activeId.value !== 'ctr-anomaly' || meta.value == null)
    return null
  return {
    totalClicksLost: typeof meta.value.totalClicksLost === 'number' ? meta.value.totalClicksLost : 0,
    totalBreachDays: typeof meta.value.totalBreachDays === 'number' ? meta.value.totalBreachDays : 0,
    zThreshold: typeof meta.value.zThreshold === 'number' ? meta.value.zThreshold : 2,
  }
})

const cannibalSummary = computed(() => {
  if (activeId.value !== 'cannibalization' || meta.value == null)
    return null
  const totalStolen = typeof meta.value.totalStolenClicks === 'number' ? meta.value.totalStolenClicks : 0
  const avgFrag = typeof meta.value.avgFragmentation === 'number' ? meta.value.avgFragmentation : 0
  return { totalStolen, avgFrag }
})

const totalPages = computed(() => {
  if (totalRows.value == null)
    return null
  return Math.max(1, Math.ceil(totalRows.value / pageSize.value))
})

const DISPLAY_KEYS = ['keyword', 'query', 'url', 'page', 'date', 'name', 'id', 'label', 'source', 'target']
const SERIES_METRIC_KEYS = ['observed', 'value', 'clicks', 'impressions', 'ctr', 'position', 'count', 'volatility', 'clicksLost']

function seriesValues(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 2)
    return null
  const first = v[0]
  if (first == null || typeof first !== 'object')
    return null
  const obj = first as Record<string, unknown>
  const metric = SERIES_METRIC_KEYS.find(k => typeof obj[k] === 'number')
  if (!metric)
    return null
  const out: number[] = []
  for (const item of v) {
    const n = (item as Record<string, unknown>)[metric]
    out.push(typeof n === 'number' && Number.isFinite(n) ? n : Number.NaN)
  }
  return out
}

function pickDisplayKey(obj: Record<string, unknown>): string | null {
  for (const k of DISPLAY_KEYS) {
    if (k in obj && (typeof obj[k] === 'string' || typeof obj[k] === 'number'))
      return k
  }
  return null
}

function fmtItem(v: unknown): string {
  if (v == null)
    return ''
  if (typeof v === 'bigint')
    return v.toLocaleString()
  if (typeof v === 'number')
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
  if (typeof v === 'string')
    return v
  if (typeof v === 'object') {
    const key = pickDisplayKey(v as Record<string, unknown>)
    if (key)
      return String((v as Record<string, unknown>)[key])
    return JSON.stringify(v)
  }
  return String(v)
}

function truncate(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function fmt(v: unknown): string {
  if (v == null)
    return ''
  if (typeof v === 'bigint')
    return v.toLocaleString()
  if (typeof v === 'number')
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
  if (Array.isArray(v)) {
    if (v.length === 0)
      return '[]'
    return truncate(`${v.length}× ${v.map(fmtItem).join(', ')}`)
  }
  if (typeof v === 'object')
    return truncate(JSON.stringify(v))
  return String(v)
}

function fmtTitle(v: unknown): string | undefined {
  if (Array.isArray(v) || (v !== null && typeof v === 'object'))
    return JSON.stringify(v, null, 2)
  return undefined
}
</script>

<template>
  <GscDashboardPage>
    <template #header>
      <GscPageHeader
        :crumbs="[
          { label: 'Overview', to: '/' },
          { label: currentSite?.hostname ?? siteId, to: `/sites/${encodeURIComponent(siteId)}` },
          { label: 'Analyze' },
        ]"
        title="Analyzer playground"
        icon="i-lucide-flask-conical"
        description="DuckDB-WASM analytics playground — parquet attached in the browser."
      >
        <template #actions>
          <GscDateRangePicker
            v-model:period="period"
            v-model:compare-mode="compareMode"
            v-model:stable-data="stableData"
          />
          <div class="flex items-center gap-2 text-xs font-mono">
            <UBadge v-if="bootError" color="error" variant="soft" icon="i-lucide-alert-circle">
              Boot failed
            </UBadge>
            <UBadge v-else-if="!isReady" color="neutral" variant="soft" icon="i-lucide-loader">
              Booting…
            </UBadge>
            <TimingPanel
              v-else
              :timings="{
                bootMs: bootTimings?.bootMs,
                manifestMs: bootTimings?.manifestMs,
                attachMs: bootTimings?.attachMs,
                rollupMs: undefined,
                queryMs: queryMs ?? undefined,
              }"
              source="browser"
            />
          </div>
        </template>
      </GscPageHeader>
    </template>

    <SiteTabs :site-id="siteId" />

    <UAlert
      v-if="bootError"
      color="error"
      icon="i-lucide-alert-circle"
      title="Failed to boot DuckDB-WASM"
      :description="bootError.message"
    />

    <!-- Analyzer sub-nav: raw + analyzer + semantic + action -->
    <nav class="flex items-center gap-0.5 border-b border-default -mb-px overflow-x-auto">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors"
        :class="[
          activeId === t.id
            ? 'border-primary text-default font-medium'
            : 'border-transparent text-muted hover:text-default',
          t.kind === 'analyzer' && activeId !== t.id ? 'text-muted/80' : '',
          (!isReady || loading) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        ]"
        :disabled="!isReady || loading"
        @click="activeId = t.id"
      >
        {{ t.label }}
      </button>
      <span v-if="queryMs != null" class="ml-auto pl-2 text-[11px] font-mono text-dimmed tabular-nums whitespace-nowrap">
        {{ Math.round(queryMs) }} ms · {{ rows.length }} rows
        <template v-if="totalRows != null"> of {{ totalRows.toLocaleString() }}</template>
      </span>
    </nav>

    <UAlert
      v-if="showAnonymizationWarning && anonymizationPct != null"
      color="warning"
      variant="soft"
      icon="i-lucide-alert-triangle"
      :title="`~${Math.round(anonymizationPct * 100)}% of impressions are anonymized by Google over the last 28 days`"
      description="Query-grained breakdowns sum to less than page-grained totals — GSC drops low-volume queries before you ever see them."
    />

    <div v-if="activeTab.kind === 'raw'" class="flex items-center gap-3 flex-wrap rounded-lg border border-default bg-default px-3 py-2">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        size="sm"
        :placeholder="`fuzzy ${(activeTab as RawTab).dim} search — space-separated tokens`"
        class="flex-1 min-w-[200px]"
        :ui="{ trailing: 'pr-1' }"
      >
        <template #trailing>
          <UButton
            v-if="search"
            color="neutral"
            variant="link"
            size="xs"
            icon="i-lucide-x"
            @click="search = ''"
          />
        </template>
      </UInput>
      <div class="flex items-center gap-3 text-xs">
        <span class="text-[11px] font-semibold text-dimmed uppercase tracking-widest">columns</span>
        <label v-for="col in METRIC_COLS" :key="col" class="flex items-center gap-1.5 cursor-pointer">
          <UCheckbox v-model="visibleMetrics[col]" size="xs" />
          <span class="text-muted tabular-nums">{{ col }}</span>
        </label>
      </div>
    </div>

    <section v-if="activeId === 'cannibalization' && cannibalGraph && !loading && !error" class="cannibal-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">events</span>
          <span class="cannibal-stat-value">{{ cannibalEvents.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">stolen clicks</span>
          <span class="cannibal-stat-value">{{ cannibalSummary ? Math.round(cannibalSummary.totalStolen).toLocaleString() : '—' }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">avg fragmentation</span>
          <span class="cannibal-stat-value">{{ cannibalSummary ? `${(cannibalSummary.avgFrag * 100).toFixed(1)}%` : '—' }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">nodes · edges</span>
          <span class="cannibal-stat-value">{{ cannibalGraph.nodes.length }} · {{ cannibalGraph.edges.length }}</span>
        </div>
      </div>
      <CannibalizationGraph
        :nodes="cannibalGraph.nodes"
        :edges="cannibalGraph.edges"
        :events="cannibalEvents"
      />
      <p class="cannibal-caption">
        Multi-URL competition per query, computed via SQL self-join in-browser.
        The GSC API can only tell you queries-per-page; never page-vs-page-per-query.
      </p>
    </section>

    <section v-else-if="activeId === 'ctr-anomaly' && !loading && !error && anomalies.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">flagged entities</span>
          <span class="cannibal-stat-value">{{ anomalies.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">clicks lost</span>
          <span class="cannibal-stat-value">{{ anomalySummary ? Math.round(anomalySummary.totalClicksLost).toLocaleString() : '—' }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">breach days (Σ)</span>
          <span class="cannibal-stat-value">{{ anomalySummary?.totalBreachDays ?? '—' }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">z threshold</span>
          <span class="cannibal-stat-value">±{{ anomalySummary?.zThreshold ?? '—' }}σ</span>
        </div>
      </div>
      <div class="anomaly-list">
        <div v-for="a in anomalies.slice(0, 30)" :key="`${a.keyword}|${a.page}`" class="anomaly-row">
          <div class="anomaly-meta">
            <div class="anomaly-kw">
              {{ a.keyword }}
            </div>
            <div class="anomaly-page">
              {{ a.page }}
            </div>
            <div class="anomaly-metrics">
              <span><b>{{ Math.round(a.clicksLost) }}</b> clicks lost</span>
              <span>·</span>
              <span><b>{{ a.breachDaysDown }}</b> breach days</span>
              <span>·</span>
              <span>max |z|=<b>{{ a.maxZ.toFixed(1) }}</b></span>
              <span>·</span>
              <span>pos <b>{{ a.baselinePosition.toFixed(1) }}</b></span>
            </div>
          </div>
          <AnomalyChart :series="a.series" />
        </div>
      </div>
      <p class="cannibal-caption">
        CTR envelope = 28-day rolling mean ±2σ via window functions. Red dots =
        days where CTR collapsed while position held (likely SERP feature theft).
      </p>
    </section>

    <section v-else-if="activeId === 'position-volatility' && !loading && !error && volatilityPages.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">volatile pages</span>
          <span class="cannibal-stat-value">{{ volatilityPages.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">days</span>
          <span class="cannibal-stat-value">{{ volatilityMeta?.dates.length ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">peak volatility</span>
          <span class="cannibal-stat-value">{{ volatilityMeta ? volatilityMeta.maxVolatility.toFixed(2) : '—' }}</span>
        </div>
      </div>
      <VolatilityHeatmap
        :pages="volatilityPages"
        :dates="volatilityMeta?.dates ?? []"
        :max-volatility="volatilityMeta?.maxVolatility ?? 1"
      />
      <p class="cannibal-caption">
        Per-page per-day position σ + DoD shift. Bright cells = pages whose
        ranking was genuinely noisy that day — not just pages that rank well.
      </p>
    </section>

    <section v-else-if="activeId === 'long-tail' && !loading && !error && longTailPages.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">pages fit</span>
          <span class="cannibal-stat-value">{{ longTailPages.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">flat-tail</span>
          <span class="cannibal-stat-value" style="color:#2d9a6a">{{ longTailSummary?.counts['flat-tail'] ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">balanced</span>
          <span class="cannibal-stat-value" style="color:#4c3ca0">{{ longTailSummary?.counts.balanced ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">head-heavy</span>
          <span class="cannibal-stat-value" style="color:#c52d45">{{ longTailSummary?.counts['head-heavy'] ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">avg slope</span>
          <span class="cannibal-stat-value">{{ longTailSummary ? longTailSummary.avgSlope.toFixed(2) : '—' }}</span>
        </div>
      </div>
      <LongTailFingerprint :pages="longTailPages" />
      <p class="cannibal-caption">
        Power-law fit: slope of log(rank) vs log(impressions) via
        REGR_SLOPE/REGR_INTERCEPT/REGR_R2. Flat = topic authority,
        steep = single-keyword dependency risk.
      </p>
    </section>

    <section v-else-if="activeId === 'intent-atlas' && !loading && !error && intentClusters.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">clusters</span>
          <span class="cannibal-stat-value">{{ intentClusters.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">keywords clustered</span>
          <span class="cannibal-stat-value">{{ intentSummary?.totalKeywords.toLocaleString() ?? '—' }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">impressions</span>
          <span class="cannibal-stat-value">{{ intentSummary ? Math.round(intentSummary.totalImpressions).toLocaleString() : '—' }}</span>
        </div>
      </div>
      <IntentTreemap :clusters="intentClusters" />
      <p class="cannibal-caption">
        Token-cooccurrence clusters via <code>regexp_split_to_array</code> +
        <code>unnest</code>. Each tile's name is its top-2 most-impression
        tokens — queries with no shared prefix still group if they share their
        dominant tokens.
      </p>
    </section>

    <section v-else-if="activeId === 'query-migration' && !loading && !error && migrationEdges.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">migration edges</span>
          <span class="cannibal-stat-value">{{ migrationEdges.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">absorbed impressions</span>
          <span class="cannibal-stat-value">{{ migrationMeta ? Math.round(migrationMeta.totalAbsorbed).toLocaleString() : '—' }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">URLs in flow</span>
          <span class="cannibal-stat-value">{{ migrationMeta?.nodes.length ?? 0 }}</span>
        </div>
        <div v-if="migrationMeta?.period" class="cannibal-stat">
          <span class="cannibal-stat-label">prev → curr</span>
          <span class="cannibal-stat-value periods">
            {{ migrationMeta.period.previous.startDate }}…{{ migrationMeta.period.previous.endDate }}
            <br>{{ migrationMeta.period.current.startDate }}…{{ migrationMeta.period.current.endDate }}
          </span>
        </div>
      </div>
      <MigrationSankey :edges="migrationEdges" :nodes="migrationMeta?.nodes ?? []" />
      <p class="cannibal-caption">
        Lost ↔ gained queries fuzzy-matched via DuckDB's
        <code>levenshtein()</code>. Edges show which URL absorbed the
        impressions Google reassigned across the two periods.
      </p>
    </section>

    <section v-else-if="activeId === 'bayesian-ctr' && !loading && !error && bayesianRows.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">entities</span>
          <span class="cannibal-stat-value">{{ bayesianRows.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">underperforming</span>
          <span class="cannibal-stat-value" style="color:#c52d45">{{ bayesianSummary?.under ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">overperforming</span>
          <span class="cannibal-stat-value" style="color:#2d9a6a">{{ bayesianSummary?.over ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">expected-click gap</span>
          <span class="cannibal-stat-value">{{ bayesianSummary ? Math.round(bayesianSummary.expectedClicksGap).toLocaleString() : '—' }}</span>
        </div>
      </div>
      <BayesianCtrPanel :rows="bayesianRows" />
      <p class="cannibal-caption">
        Empirical Beta-Binomial shrinkage. Prior fit per position bucket via
        method-of-moments on impression-weighted CTR; posterior = Beta(α+clicks, β+impr-clicks).
        95% CI = normal approx around posterior mean. Only flags entities
        where the observed rate is outside its prior-informed credible range.
      </p>
    </section>

    <section v-else-if="activeId === 'stl-decompose' && !loading && !error && stlEntities.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">entities</span>
          <span class="cannibal-stat-value">{{ stlEntities.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">avg seasonal strength</span>
          <span class="cannibal-stat-value">{{ (stlEntities.reduce((s, e) => s + e.seasonalStrength, 0) / stlEntities.length).toFixed(2) }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">residual anomalies (Σ)</span>
          <span class="cannibal-stat-value">{{ stlEntities.reduce((s, e) => s + e.residualAnomalies, 0) }}</span>
        </div>
      </div>
      <StlPanel :entities="stlEntities" metric="impressions" />
      <p class="cannibal-caption">
        Classical additive decomposition: trend = centered 7-day MA, seasonal =
        AVG of detrended per weekday, residual = observed − trend − seasonal.
        Residual anomalies survive both trend + weekly seasonality.
      </p>
    </section>

    <section v-if="activeId === 'bipartite-pagerank' && !loading && !error && pageRankNodes.length > 0 && pageRankMeta" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">iterations</span>
          <span class="cannibal-stat-value">{{ pageRankMeta.iterations }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">damping</span>
          <span class="cannibal-stat-value">{{ pageRankMeta.damping }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">L1 Δ (final)</span>
          <span class="cannibal-stat-value">{{ pageRankMeta.convergenceDelta.toExponential(2) }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">queries · URLs</span>
          <span class="cannibal-stat-value">{{ pageRankMeta.queryCount }} · {{ pageRankMeta.urlCount }}</span>
        </div>
      </div>
      <BipartitePageRankPanel :nodes="pageRankNodes" :meta="pageRankMeta" />
      <p class="cannibal-caption">
        Personalized PageRank on the query↔URL bipartite graph via DuckDB
        recursive-style CTE chain (bounded-unroll power iteration, 25 steps).
        Hub queries bridge many URLs; hub URLs anchor many queries.
      </p>
    </section>

    <section v-else-if="activeId === 'survival' && !loading && !error && survivalCohorts.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">episodes</span>
          <span class="cannibal-stat-value">{{ survivalMeta?.totalEpisodes ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">cohorts</span>
          <span class="cannibal-stat-value">{{ survivalMeta?.cohortCount ?? 0 }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">window</span>
          <span class="cannibal-stat-value">{{ survivalMeta?.windowDays ?? 180 }}d</span>
        </div>
      </div>
      <SurvivalPanel :cohorts="survivalCohorts" :window-days="survivalMeta?.windowDays" />
      <p class="cannibal-caption">
        Kaplan-Meier survival curves. An episode starts when a keyword
        enters the top 10; it dies when position rises above 10. S(t) =
        Π(1 − d/n) computed in SQL via
        <code>EXP(SUM(LN(...)))</code>; at-risk via reverse cumulative sum.
      </p>
    </section>

    <section v-else-if="activeId === 'actions'" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">status</span>
          <span class="cannibal-stat-value contgap-phase">{{ actionPriority.progress.value.phase }}</span>
        </div>
        <div v-if="actionPriority.progress.value.total" class="cannibal-stat">
          <span class="cannibal-stat-label">progress</span>
          <span class="cannibal-stat-value">{{ actionPriority.progress.value.completed ?? 0 }} / {{ actionPriority.progress.value.total }}</span>
        </div>
        <div v-if="actionPriority.actions.value.length > 0" class="cannibal-stat">
          <span class="cannibal-stat-label">actions</span>
          <span class="cannibal-stat-value">{{ actionPriority.actions.value.length }}</span>
        </div>
        <button
          class="cg-run"
          :disabled="!isReady || actionPriority.running.value"
          @click="actionPriority.run(runner)"
        >
          {{ actionPriority.running.value ? 'Running…' : actionPriority.actions.value.length > 0 ? 'Re-run' : 'Generate action plan' }}
        </button>
      </div>
      <div v-if="actionPriority.error.value" class="err-box">
        {{ actionPriority.error.value.message }}
      </div>
      <div v-else-if="actionPriority.progress.value.phase === 'running'" class="cg-status">
        {{ actionPriority.progress.value.message }}
      </div>
      <ActionPriorityPanel v-if="actionPriority.actions.value.length > 0" :actions="actionPriority.actions.value" />
      <div v-else-if="actionPriority.progress.value.phase === 'idle'" class="cg-intro">
        <h3>Action priority dashboard</h3>
        <p>
          Runs five analyzers in parallel (striking-distance, opportunity,
          cannibalization, ctr-anomaly, change-point), dedupes by keyword+page,
          and ranks by composite <code>impact × severity × effortMultiplier</code>.
        </p>
        <p>
          One tab to rule them all: the top 40 actions across the whole site.
        </p>
      </div>
      <p class="cannibal-caption">
        Actions are deduped across sources — a keyword flagged by both
        striking-distance and cannibalization surfaces as one action with
        both source tags. Effort heuristic picks the lowest (fixing the
        on-page lever usually unblocks the SERP one).
      </p>
    </section>

    <section v-else-if="activeId === 'content-gap'" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">status</span>
          <span class="cannibal-stat-value contgap-phase">{{ contentGap.progress.value.phase }}</span>
        </div>
        <div v-if="contentGap.progress.value.total" class="cannibal-stat">
          <span class="cannibal-stat-label">progress</span>
          <span class="cannibal-stat-value">{{ contentGap.progress.value.done ?? 0 }} / {{ contentGap.progress.value.total }}</span>
        </div>
        <div v-if="contentGap.progress.value.modelMs" class="cannibal-stat">
          <span class="cannibal-stat-label">model load</span>
          <span class="cannibal-stat-value">{{ Math.round(contentGap.progress.value.modelMs) }}ms</span>
        </div>
        <div v-if="contentGap.progress.value.embedMs" class="cannibal-stat">
          <span class="cannibal-stat-label">embed</span>
          <span class="cannibal-stat-value">{{ Math.round(contentGap.progress.value.embedMs) }}ms</span>
        </div>
        <div v-if="contentGap.results.value.length > 0" class="cannibal-stat">
          <span class="cannibal-stat-label">gaps found</span>
          <span class="cannibal-stat-value">{{ contentGap.results.value.length }}</span>
        </div>
        <button
          class="cg-run"
          :disabled="!isReady || contentGap.running.value"
          @click="contentGap.run(runner)"
        >
          {{ contentGap.running.value ? 'Running…' : contentGap.results.value.length > 0 ? 'Re-run' : 'Detect content gaps' }}
        </button>
      </div>

      <div v-if="contentGap.error.value" class="err-box">
        {{ contentGap.error.value.message }}
      </div>

      <div v-if="contentGap.progress.value.phase !== 'done' && contentGap.progress.value.phase !== 'idle'" class="cg-status">
        {{ contentGap.progress.value.message }}
        <div v-if="contentGap.progress.value.total" class="cg-progress-bar">
          <div class="cg-progress-fill" :style="{ width: `${((contentGap.progress.value.done ?? 0) / contentGap.progress.value.total) * 100}%` }" />
        </div>
      </div>

      <ContentGapPanel v-if="contentGap.results.value.length > 0" :rows="contentGap.results.value" />

      <div v-else-if="contentGap.progress.value.phase === 'idle'" class="cg-intro">
        <h3>Semantic content-gap detection</h3>
        <p>
          Embeds every top query and every URL via a local MiniLM model (22MB,
          cached in IndexedDB after first run). Cosine-matches each query to
          its best semantic URL, then flags queries where Google ranks you on
          a different URL than the one that <em>topically</em> fits best.
        </p>
        <p>
          Runs 100% in-browser. No API calls, no data leaves the tab.
          After first download, re-runs take seconds.
        </p>
      </div>

      <p class="cannibal-caption">
        Embeddings: <code>Xenova/bge-base-en-v1.5</code> (fp32, 768-dim) via
        <code>@huggingface/transformers</code>, WebGPU if available. Queries
        use the BGE retrieval prefix; URL passages don't. Embeddings cached
        in IndexedDB, URLs deduped by canonical pathname. Divergence =
        cosine(query, bestUrl) − cosine(query, currentUrl).
      </p>
    </section>

    <section v-else-if="activeId === 'change-point' && !loading && !error && changePointEntities.length > 0" class="anomaly-panel">
      <div class="cannibal-headline">
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">change points</span>
          <span class="cannibal-stat-value">{{ changePointEntities.length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">improved</span>
          <span class="cannibal-stat-value" style="color:#2d9a6a">{{ changePointEntities.filter(e => e.direction === 'improved').length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">worsened</span>
          <span class="cannibal-stat-value" style="color:#c52d45">{{ changePointEntities.filter(e => e.direction === 'worsened').length }}</span>
        </div>
        <div class="cannibal-stat">
          <span class="cannibal-stat-label">max LLR</span>
          <span class="cannibal-stat-value">{{ changePointEntities.length > 0 ? changePointEntities[0]!.llr.toFixed(1) : '—' }}</span>
        </div>
      </div>
      <ChangePointPanel :entities="changePointEntities" metric="position" />
      <p class="cannibal-caption">
        Binary-segmentation change-point detection: at each candidate split
        date, compare Gaussian log-likelihood of one-segment vs two-segment
        fits. LLR = Σ n·log(σ²) differential. High LLR = the regime genuinely
        flipped on that date; low LLR = gradual drift.
      </p>
    </section>

    <section v-else class="panel">
      <div v-if="loading" class="loading">
        Running query…
      </div>
      <div v-else-if="error" class="err-box">
        {{ error }}
      </div>
      <div v-else-if="rows.length === 0 && isReady" class="empty">
        No rows.
      </div>
      <div v-else-if="rows.length > 0" class="wrap">
        <table>
          <thead>
            <tr>
              <th
                v-for="c in visibleColumns" :key="c"
                :class="{ sortable: isSortable(c), active: sort?.column === c }"
                @click="toggleSort(c)"
              >
                {{ c }}
                <span v-if="sort?.column === c && isSortable(c)" class="arrow">{{ sort.direction === 'desc' ? '▼' : '▲' }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in displayRows" :key="i">
              <td v-for="c in visibleColumns" :key="c" :title="fmtTitle(row[c])" :class="{ num: typeof row[c] === 'number' || typeof row[c] === 'bigint' }">
                <Sparkline v-if="seriesValues(row[c])" :values="seriesValues(row[c])!" />
                <template v-else>
                  {{ fmt(row[c]) }}
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="activeTab.kind === 'raw' && totalPages != null" class="pager">
      <button :disabled="page === 1 || loading" @click="page = 1">
        ⟪
      </button>
      <button :disabled="page === 1 || loading" @click="page--">
        ‹
      </button>
      <span>Page {{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages || loading" @click="page++">
        ›
      </button>
      <button :disabled="page >= totalPages || loading" @click="page = totalPages">
        ⟫
      </button>
      <label class="pagesize">per page
        <select v-model.number="pageSize">
          <option :value="10">
            10
          </option>
          <option :value="25">
            25
          </option>
          <option :value="50">
            50
          </option>
          <option :value="100">
            100
          </option>
        </select>
      </label>
    </div>
  </GscDashboardPage>
</template>

<style scoped>
/* Shell / tabs / toolbar / anonymization banner moved to @nuxt/ui.
   Below: per-analyzer panels + the raw/analyzer data table. These
   visualizations predate the layer and aren't worth porting until a second
   consumer needs them. */

.panel { background: var(--ui-bg); border: 1px solid var(--ui-border); border-radius: 8px; overflow: hidden; }
.loading, .empty { padding: 2.5rem; text-align: center; color: var(--ui-text-dimmed); font-size: 0.9rem; }
.err-box { padding: 1rem 1.25rem; color: #c00; background: #fff5f5; font-family: ui-monospace, monospace; font-size: 0.82rem; white-space: pre-wrap; }

.wrap { overflow-x: auto; max-height: 70vh; }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th, td { padding: 0.45rem 0.85rem; border-bottom: 1px solid var(--ui-border); text-align: left; white-space: nowrap; }
th { background: var(--ui-bg-elevated); font-weight: 600; position: sticky; top: 0; font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ui-text-dimmed); user-select: none; }
th.sortable { cursor: pointer; }
th.sortable:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
th.active { color: var(--ui-text-highlighted); }
th .arrow { margin-left: 0.3em; font-size: 0.65rem; }
td.num { font-variant-numeric: tabular-nums; text-align: right; }
tbody tr:hover { background: var(--ui-bg-elevated); }

.pager { display: flex; gap: 0.4rem; align-items: center; padding: 0.6rem 0; font-size: 0.82rem; color: var(--ui-text-muted); }
.pager button { min-width: 2rem; padding: 0.3rem 0.6rem; border: 1px solid var(--ui-border); border-radius: 4px; background: var(--ui-bg); cursor: pointer; color: var(--ui-text); }
.pager button:disabled { opacity: 0.4; cursor: not-allowed; }
.pager .pagesize { margin-left: auto; display: inline-flex; align-items: center; gap: 0.4rem; color: var(--ui-text-dimmed); font-size: 0.78rem; }
.pager select { padding: 0.2rem 0.3rem; border: 1px solid var(--ui-border); border-radius: 4px; font-size: 0.82rem; background: var(--ui-bg); }

.cannibal-panel { background: #fff; border: 1px solid #ececef; border-top: 0; border-radius: 0 0 6px 6px; padding: 1rem 1rem 0.9rem; }
.cannibal-headline { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 0.85rem; padding: 0 0.15rem; }
.cannibal-stat { display: flex; flex-direction: column; gap: 0.1rem; }
.cannibal-stat-label { font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase; color: #888; }
.cannibal-stat-value { font-size: 1.3rem; font-weight: 600; color: #1d1d1f; font-variant-numeric: tabular-nums; }
.cannibal-caption { margin: 0.8rem 0 0; font-size: 0.78rem; color: #666; font-style: italic; text-align: center; }

.anomaly-panel { background: #fff; border: 1px solid #ececef; border-top: 0; border-radius: 0 0 6px 6px; padding: 1rem 1rem 0.9rem; }
.anomaly-list { display: flex; flex-direction: column; gap: 0; max-height: 65vh; overflow-y: auto; border: 1px solid #f0f0f2; border-radius: 4px; }
.anomaly-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 1rem; padding: 0.7rem 0.9rem; border-bottom: 1px solid #f4f4f6; }
.anomaly-row:last-child { border-bottom: 0; }
.anomaly-row:hover { background: #fafafb; }
.anomaly-meta { min-width: 0; }
.anomaly-kw { font-weight: 600; font-size: 0.88rem; color: #1d1d1f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.anomaly-page { font-family: ui-monospace, monospace; font-size: 0.72rem; color: #7a6cd0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0.1rem 0 0.3rem; }
.anomaly-metrics { font-size: 0.74rem; color: #888; display: flex; gap: 0.4rem; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.anomaly-metrics b { color: #1d1d1f; font-weight: 600; }
.cannibal-stat-value.periods { font-size: 0.7rem; font-family: ui-monospace, monospace; line-height: 1.3; }
.cannibal-caption code { background: #f0f0f3; padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.74rem; color: #4c3ca0; }

.contgap-phase { font-size: 0.85rem; color: #4c3ca0; font-family: ui-monospace, monospace; text-transform: lowercase; }
.cg-run { margin-left: auto; padding: 0.55rem 1.1rem; border: 0; border-radius: 4px; background: #4c3ca0; color: #fff; font-weight: 600; font-size: 0.82rem; cursor: pointer; transition: background 0.15s; }
.cg-run:hover:not(:disabled) { background: #3a2c85; }
.cg-run:disabled { opacity: 0.5; cursor: not-allowed; }
.cg-status { padding: 0.7rem 0.9rem; background: #f6f6fb; border: 1px solid #e4e4f0; border-radius: 4px; margin-bottom: 0.8rem; font-size: 0.8rem; color: #444; }
.cg-progress-bar { margin-top: 0.4rem; height: 4px; background: #e4e4f0; border-radius: 2px; overflow: hidden; }
.cg-progress-fill { height: 100%; background: linear-gradient(90deg, #7a6cd0, #4c3ca0); transition: width 0.2s; }
.cg-intro { padding: 2rem 1.5rem; text-align: center; background: #fafafb; border: 1px dashed #e4e4f0; border-radius: 6px; }
.cg-intro h3 { margin: 0 0 0.8rem; font-size: 1.05rem; color: #1d1d1f; }
.cg-intro p { margin: 0.5rem auto; max-width: 540px; font-size: 0.85rem; color: #555; line-height: 1.55; }
.cg-intro em { color: #4c3ca0; font-style: italic; }
</style>
