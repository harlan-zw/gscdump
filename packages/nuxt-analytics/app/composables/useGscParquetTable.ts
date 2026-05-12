// Parquet-attached DuckDB table view: fuzzy-search + sortable metrics +
// pagination over a single attached parquet (`main.<table>`), date-filtered.
//
// Sibling of `useGscRollupTable` — the rollup variant fetches a precomputed
// JSON payload; this variant fires SQL against a parquet view in the
// browser-attached DuckDB-WASM runtime. Two callers today (analyze.vue's
// `pages` and `keywords` raw tabs); third+ callers are mechanical.
//
// Caller passes the `query` fn from `useGscAnalyzer(siteId)`; the composable
// owns the SQL builder, the debounce, the watcher, and the count+page
// Promise.all. It does NOT own `period`/`sort`/`page`/`q` — those are passed
// in so callers can deep-link and share state (the `/analyze` page wires one
// `useGscTableState` across raw + analyzer tabs).

import type { MaybeRefOrGetter, Ref } from '@vue/runtime-core'
import type { GscSortState } from './useGscTableState'

interface QueryResult { rows: Record<string, unknown>[], queryMs: number }

export interface UseGscParquetTableOptions {
  /** Attached view name in `main.<table>` (e.g. `pages`, `keywords`). */
  table: MaybeRefOrGetter<string>
  /** Dimension column rows group by + fuzzy-search against. */
  dim: MaybeRefOrGetter<string>
  /** `useGscAnalyzer(siteId).query`. */
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  /** Date window applied as `date BETWEEN ? AND ?`. */
  dateRange: MaybeRefOrGetter<{ start: string, end: string }>
  /**
   * External table state — search, sort, page, pageSize. Usually a shared
   *  `useGscTableState()` so URL deep-links survive tab switches.
   */
  q: Ref<string>
  sort: Ref<GscSortState | null>
  page: Ref<number>
  pageSize: Ref<number>
  /** Gate firing the query until the underlying runtime is ready. */
  ready: MaybeRefOrGetter<boolean>
  /** Re-fire whenever any of these change. (Period state, stableData flag, …) */
  triggers?: MaybeRefOrGetter<unknown>[]
  /** Search debounce. Default 200ms. */
  debounceMs?: number
}

export interface UseGscParquetTableReturn {
  rows: Ref<Record<string, unknown>[]>
  totalRows: Ref<number | null>
  totalPages: Ref<number | null>
  queryMs: Ref<number | null>
  loading: Ref<boolean>
  error: Ref<string | null>
}

const SQL_SORT_COLS = new Set(['clicks', 'impressions', 'ctr', 'avg_position'])
const WHITESPACE_RE = /\s+/

function tokenize(s: string): string[] {
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

interface SearchClauses { where: string, rank: string, params: unknown[] }

function buildSearchClauses(dim: string, tokens: string[]): SearchClauses {
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

function withDateFilter(
  searchWhere: string,
  searchParams: unknown[],
  start: string,
  end: string,
): { where: string, params: unknown[] } {
  const dateClause = 'date BETWEEN ? AND ?'
  const where = searchWhere ? `${searchWhere} AND ${dateClause}` : `WHERE ${dateClause}`
  return { where, params: [...searchParams, start, end] }
}

function sortKey(dim: string, sort: GscSortState | null): string {
  const col = sort?.column ?? 'clicks'
  if (SQL_SORT_COLS.has(col))
    return col
  if (col === dim)
    return dim
  return 'clicks'
}

export function useGscParquetTable(opts: UseGscParquetTableOptions): UseGscParquetTableReturn {
  const rows = ref<Record<string, unknown>[]>([])
  const totalRows = ref<number | null>(null)
  const queryMs = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const searchDebounced = ref('')
  let handle: ReturnType<typeof setTimeout> | null = null
  watch(opts.q, (v: string) => {
    if (handle)
      clearTimeout(handle)
    handle = setTimeout(() => {
      searchDebounced.value = v
    }, opts.debounceMs ?? 200)
  })

  async function run(): Promise<void> {
    if (!toValue(opts.ready))
      return
    const table = toValue(opts.table)
    const dim = toValue(opts.dim)
    const { start, end } = toValue(opts.dateRange)
    const tokens = tokenize(searchDebounced.value)
    const { where: searchWhere, rank, params: searchParams } = buildSearchClauses(dim, tokens)
    const dir = (opts.sort.value?.direction ?? 'desc').toUpperCase()
    const limit = opts.pageSize.value
    const offset = (opts.page.value - 1) * limit

    const wherePart = withDateFilter(searchWhere, searchParams.slice(0, tokens.length), start, end)
    const rankParams = searchParams.slice(tokens.length)

    const pageSql = `
      SELECT ${dim},
             SUM(clicks)::BIGINT AS clicks,
             SUM(impressions)::BIGINT AS impressions,
             CASE WHEN SUM(impressions) > 0
                  THEN ROUND(SUM(clicks) * 1.0 / SUM(impressions), 4)
                  ELSE 0 END AS ctr,
             CASE WHEN SUM(impressions) > 0
                  THEN ROUND(SUM(sum_position) / SUM(impressions) + 1, 2)
                  ELSE 0 END AS avg_position
      FROM main.${table}
      ${wherePart.where}
      GROUP BY ${dim}
      ORDER BY ${rank} ${sortKey(dim, opts.sort.value)} ${dir}
      LIMIT ${limit} OFFSET ${offset}
    `
    const countSql = `SELECT COUNT(DISTINCT ${dim})::BIGINT AS n FROM main.${table} ${wherePart.where}`

    loading.value = true
    error.value = null
    rows.value = []
    queryMs.value = null
    try {
      const [pageRes, countRes] = await Promise.all([
        opts.query(pageSql, [...wherePart.params, ...rankParams]),
        opts.query(countSql, wherePart.params),
      ])
      rows.value = pageRes.rows
      queryMs.value = pageRes.queryMs
      const n = countRes.rows[0]?.n
      totalRows.value = typeof n === 'bigint' ? Number(n) : typeof n === 'number' ? n : null
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
    finally {
      loading.value = false
    }
  }

  const triggerSources = [
    () => toValue(opts.ready),
    () => toValue(opts.table),
    () => toValue(opts.dim),
    () => toValue(opts.dateRange),
    opts.sort,
    opts.page,
    opts.pageSize,
    searchDebounced,
    ...(opts.triggers ?? []).map(t => () => toValue(t as MaybeRefOrGetter<unknown>)),
  ]
  watch(triggerSources, () => {
    void run()
  })

  const totalPages = computed(() => {
    if (totalRows.value == null)
      return null
    return Math.max(1, Math.ceil(totalRows.value / opts.pageSize.value))
  })

  return { rows, totalRows, totalPages, queryMs, loading, error }
}
