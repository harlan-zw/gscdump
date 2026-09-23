// Paging loop over GSC Search Analytics for a single (site, table, date-range,
// searchType) slice. Hosts inject the client + per-batch handler (e.g. row
// accumulator push or D1 upsert) + telemetry callback. Pure orchestration —
// no D1, no queue, no manifest.

import type { SearchType } from '@gscdump/engine'
import type {
  GoogleSearchConsoleClient,
  SearchAnalyticsQuery,
} from 'gscdump'
import type {
  GscDataState,
  GscSearchAnalyticsMetadata,
} from 'gscdump/contracts'

export interface GscApiRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface SyncSliceDomainFilter {
  /**
   * Exact registered host to scope the slice to, without a protocol.
   * `www.example.com` and `example.com` remain separate hosts.
   */
  domain?: string
}

export interface SyncSliceDimensionFilter {
  dimension: 'page' | 'query' | 'country' | 'device' | 'searchAppearance'
  operator?: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex'
  expression: string
}

export interface RunGscSyncSliceOptions {
  client: GoogleSearchConsoleClient
  siteUrl: string
  /** One of the engine sync-fan tables. Drives the dimension list. */
  table: 'pages' | 'queries' | 'countries' | 'dates' | 'page_queries' | 'search_appearance' | 'search_appearance_pages' | 'search_appearance_queries' | 'search_appearance_page_queries' | 'hourly_pages'
  startDate: string
  endDate: string
  domainFilter?: SyncSliceDomainFilter | null
  /** Additional AND filters, e.g. `searchAppearance = AMP_BLUE_LINK`. */
  dimensionFilters?: SyncSliceDimensionFilter[]
  /**
   * Override the dimension list for this slice. Defaults to
   *  `DIMENSIONS_BY_TABLE[table]`. Hosts that need bespoke groupings (e.g.
   *  hourly Discover variants) supply this directly.
   */
  dimensions?: string[]
  /**
   * GSC `dataState` for the query. Defaults to `'all'`. Use `'hourly_all'`
   *  for hourly Discover slices.
   */
  dataState?: GscDataState
  /**
   * Invoked per GSC API page with the rows fetched. Return a promise; the
   *  loop awaits it before paging further. Throw a durable error to abort the
   *  slice. A thrown AbortError / timeout stops the loop and returns retry
   *  state at the current cursor so the continuation re-processes this page.
   */
  onBatch: (rows: GscApiRow[]) => Promise<void>
  initialStartRow?: number
  /**
   * Max GSC API pages per call. `Infinity` for unbounded; hosts cap this
   *  based on path (D1 vs R2) and table.
   */
  maxPages?: number
  /** GSC page size. 500 is the D1-safe default; 10k is the R2 path. */
  rowLimit?: number
  /**
   * Soft CPU budget for the loop itself. Returns `hasMore` when crossed so
   *  the continuation resumes from `nextStartRow`.
   */
  cpuBudgetMs?: number
  searchType?: SearchType
  /** Invoked once per successful GSC API page. Hosts wire telemetry here. */
  onPage?: (info: { searchType: SearchType, rowsThisPage: number }) => void
}

export interface RunGscSyncSliceResult {
  totalRows: number
  hasMore: boolean
  nextStartRow: number
  /**
   * Metadata from the LAST GSC API page seen during this slice run. When
   *  `dataState='hourly_all'` and grouped by `hour`, this surfaces
   *  `first_incomplete_hour` so hosts can watermark hourly progress.
   */
  metadata?: GscSearchAnalyticsMetadata
}

export type SearchAppearanceContextGrain = 'page' | 'query' | 'page_query'
export type SearchAppearanceContextTable = 'search_appearance_pages' | 'search_appearance_queries' | 'search_appearance_page_queries'

export interface RunGscSearchAppearanceContextSliceOptions {
  client: GoogleSearchConsoleClient
  siteUrl: string
  startDate: string
  endDate: string
  domainFilter?: SyncSliceDomainFilter | null
  /** Use a known appearance list to skip discovery. */
  appearances?: string[]
  /** Context grain to fetch for every discovered appearance. Defaults to page_query. */
  grain?: SearchAppearanceContextGrain
  /** Context table to fetch. Overrides `grain` when provided. */
  table?: SearchAppearanceContextTable
  dataState?: GscDataState
  rowLimit?: number
  maxPages?: number
  cpuBudgetMs?: number
  searchType?: SearchType
  onTotalBatch?: (rows: GscApiRow[]) => Promise<void>
  onContextBatch: (batch: { searchAppearance: string, table: SearchAppearanceContextTable, rows: GscApiRow[] }) => Promise<void>
  onPage?: (info: { searchType: SearchType, rowsThisPage: number }) => void
  continuation?: SearchAppearanceContinuation
}

export type SearchAppearanceContinuation
  = | { phase: 'discovery', appearances: string[], nextStartRow: number }
    | { phase: 'context', appearances: string[], appearanceIndex: number, nextStartRow: number }

export interface RunGscSearchAppearanceContextSliceResult {
  appearances: string[]
  totalRows: number
  hasMore: boolean
  continuation?: SearchAppearanceContinuation
  /**
   * Metadata from the LAST GSC API page seen, across the discovery and
   * context queries. With the default `dataState='all'` it carries
   * `first_incomplete_date` / `first_incomplete_hour` so hosts can keep
   * still-updating days pending.
   */
  metadata?: GscSearchAnalyticsMetadata
}

// Keyed by engine `SyncTableName` (post Iceberg rename). `dates` fetches the
// `['device', 'date']` grain: the legacy D1 path stores it row-grained in
// `gsc_devices`, and the Iceberg `dates` ingest pivots the device rows (plus a
// separate `['date']` site-total query) into the wide `dates` table.
const DIMENSIONS_BY_TABLE = {
  pages: ['page', 'date'],
  queries: ['query', 'date'],
  countries: ['country', 'date'],
  dates: ['device', 'date'],
  page_queries: ['page', 'query', 'date'],
  // GSC only allows `searchAppearance` as a sole grouped dimension. Date/page/
  // query context must be fetched by a second query filtered to one appearance.
  search_appearance: ['searchAppearance'],
  search_appearance_pages: ['page', 'date'],
  search_appearance_queries: ['query', 'date'],
  search_appearance_page_queries: ['page', 'query', 'date'],
  hourly_pages: ['hour', 'page'],
} as const

function isTimeoutLike(err: unknown): boolean {
  if (!(err instanceof Error))
    return false
  return err.name === 'AbortError' || err.message?.includes('timeout') || err.message?.includes('aborted')
}

// Scope each slice to the exact registered host, including its www prefix.
// A broader Search Console property must not widen this scope.
// The page filter excludes every other host, including the alternate www host.
//
// Behaviour of attaching this filter, measured 2026-05 (see gscdump.com
// docs/postmortems/2026-05-gsc-page-filter-sampling.md):
//  - With `page` / `date` dimensions (the `pages` slice) it is side-effect free:
//    GSC switches to by-page aggregation and returns a total >= the by-property
//    total. No sampling.
//  - With `device` / `country` / `query` dimensions GSC anonymizes at the
//    (page x dim) grain and the long-tail collapses the total to the anonymized
//    floor (observed ‑37% to ‑79%). The `devices` / `countries` slices are
//    therefore undercounted on `sc-domain:` properties — a known limitation,
//    NOT a reason to drop the filter (the `pages`/`keywords` slices need it).
// Only `groupType: 'and'` is valid; GSC rejects `'or'` with HTTP 400.
interface SyncSliceApiFilter {
  dimension: SyncSliceDimensionFilter['dimension']
  operator: NonNullable<SyncSliceDimensionFilter['operator']>
  expression: string
}

function buildDimensionFilterGroups(
  domainFilter: SyncSliceDomainFilter | null | undefined,
  filters: readonly SyncSliceDimensionFilter[] = [],
): { filters: SyncSliceApiFilter[] }[] | undefined {
  const out: SyncSliceApiFilter[] = filters.map(f => ({
    dimension: f.dimension,
    operator: f.operator ?? 'equals',
    expression: f.expression,
  }))
  if (domainFilter?.domain) {
    const escapedDomain = domainFilter.domain.replace(/\./g, '\\.')
    const pattern = `^https?://${escapedDomain}/`
    out.push({
      dimension: 'page',
      operator: 'includingRegex',
      expression: pattern,
    })
  }
  return out.length > 0 ? [{ filters: out }] : undefined
}

export async function runGscSyncSlice(
  opts: RunGscSyncSliceOptions,
): Promise<RunGscSyncSliceResult> {
  const rowLimit = opts.rowLimit ?? 500
  const cpuBudgetMs = opts.cpuBudgetMs ?? 20_000
  const maxPages = opts.maxPages ?? Infinity
  const searchType: SearchType = opts.searchType ?? 'web'
  const dimensions = opts.dimensions
    ? [...opts.dimensions]
    : [...DIMENSIONS_BY_TABLE[opts.table]]
  const dataState: GscDataState = opts.dataState ?? (dimensions.includes('hour') ? 'hourly_all' : 'all')
  const dimensionFilterGroups = buildDimensionFilterGroups(opts.domainFilter, opts.dimensionFilters)

  const loopStart = Date.now()
  let startRow = opts.initialStartRow ?? 0
  let totalRows = 0
  let pageCount = 0
  let metadata: GscSearchAnalyticsMetadata | undefined

  // One GSC page fetch, wrapped so the returned promise NEVER rejects. The
  // pipeline below may kick off a prefetch it then discards (a write timeout /
  // a thrown write returns early); an unwrapped rejection on that orphaned
  // promise would surface as an unhandled rejection. Timeout-like fetch failures
  // become a `timeout` result (retry at this cursor); any other error is carried
  // and rethrown only when the page is consumed, preserving serial throw-order.
  type PageResult
    = | { kind: 'ok', startRow: number, rows: GscApiRow[], metadata?: GscSearchAnalyticsMetadata }
      | { kind: 'timeout', startRow: number }
      | { kind: 'error', error: unknown }
  const fetchPage = async (row: number): Promise<PageResult> => {
    const query: SearchAnalyticsQuery = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions,
      rowLimit,
      startRow: row,
      dataState,
      type: searchType,
      ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
    }
    try {
      const response = await opts.client.searchAnalytics.query(opts.siteUrl, query)
      return {
        kind: 'ok',
        startRow: row,
        rows: (response.rows ?? []) as GscApiRow[],
        metadata: (response as { metadata?: GscSearchAnalyticsMetadata }).metadata,
      }
    }
    catch (err) {
      if (isTimeoutLike(err))
        return { kind: 'timeout', startRow: row }
      return { kind: 'error', error: err }
    }
  }

  // Gate a fetch on the page budget + soft CPU budget, mirroring the serial
  // top-of-loop checks. `null` ⇒ "don't page further"; the caller returns
  // `hasMore` at the pending cursor.
  const startFetchIfAllowed = (row: number): Promise<PageResult> | null => {
    if (pageCount >= maxPages)
      return null
    if (Date.now() - loopStart >= cpuBudgetMs)
      return null
    return fetchPage(row)
  }

  // Pipeline: hold at most one page fetch in flight while the previous page's
  // `onBatch` write runs, so the GSC round-trip latency of page N+1 overlaps the
  // write of page N instead of serializing behind it. Peak memory is bounded at
  // two pages (one being written, one prefetching). The CPU budget stays soft:
  // because the prefetch gate is checked just before the write (not after), the
  // loop may page at most ONE extra time past `cpuBudgetMs` — the inherent cost
  // of look-ahead, negligible against the queue reservation window.
  let pending: Promise<PageResult> | null = startFetchIfAllowed(startRow)
  if (pending === null)
    return { totalRows, hasMore: true, nextStartRow: startRow, metadata }

  while (pending !== null) {
    const page: PageResult = await pending
    pending = null

    if (page.kind === 'error')
      throw page.error
    if (page.kind === 'timeout')
      return { totalRows, hasMore: true, nextStartRow: page.startRow, metadata }

    const rows: GscApiRow[] = page.rows
    totalRows += rows.length
    pageCount++
    if (page.metadata)
      metadata = page.metadata
    opts.onPage?.({ searchType, rowsThisPage: rows.length })

    const isLastPage: boolean = rows.length === 0
    const nextStartRow: number = page.startRow + rows.length

    // Kick the next fetch off NOW so its latency overlaps the write below —
    // unless this is the final page or the budget gate stops us.
    const prefetch: Promise<PageResult> | null = isLastPage ? null : startFetchIfAllowed(nextStartRow)

    if (rows.length > 0) {
      const batchTimedOut = await opts.onBatch(rows).then(() => false).catch((err: unknown) => {
        if (isTimeoutLike(err))
          return true
        throw err
      })
      // A timed-out durable write is ambiguous — the rows may never have been
      // persisted. Return retry state at THIS page's cursor so the continuation
      // re-processes it rather than advancing past it (a silent gap). The
      // in-flight `prefetch` is dropped (it never rejects); the continuation
      // re-fetches that page. Mirrors the Search Analytics timeout path.
      if (batchTimedOut)
        return { totalRows: totalRows - rows.length, hasMore: true, nextStartRow: page.startRow, metadata }
    }

    if (isLastPage)
      return { totalRows, hasMore: false, nextStartRow, metadata }
    if (prefetch === null)
      // Budget / maxPages gate hit mid-slice — more rows remain.
      return { totalRows, hasMore: true, nextStartRow, metadata }

    startRow = nextStartRow
    pending = prefetch
  }

  // Unreachable — every loop path returns. Present so the function is total for
  // the type-checker (the loop guard alone doesn't prove a return).
  return { totalRows, hasMore: false, nextStartRow: startRow, metadata }
}

function contextTableForGrain(grain: SearchAppearanceContextGrain): SearchAppearanceContextTable {
  switch (grain) {
    case 'page':
      return 'search_appearance_pages'
    case 'query':
      return 'search_appearance_queries'
    case 'page_query':
      return 'search_appearance_page_queries'
  }
}

/**
 * Implements GSC's required two-step search-appearance flow:
 * 1. group by `searchAppearance` alone to discover available appearances;
 * 2. for each appearance, filter by it and fetch page/query/date context.
 */
export async function runGscSearchAppearanceContextSlice(
  opts: RunGscSearchAppearanceContextSliceOptions,
): Promise<RunGscSearchAppearanceContextSliceResult> {
  const table = opts.table ?? contextTableForGrain(opts.grain ?? 'page_query')
  const appearances = opts.continuation?.appearances?.slice() ?? opts.appearances?.slice() ?? []
  let totalRows = 0
  let hasMore = false
  let metadata: GscSearchAnalyticsMetadata | undefined

  if (!opts.appearances && opts.continuation?.phase !== 'context') {
    const discovered = new Set<string>(appearances)
    const discovery = await runGscSyncSlice({
      client: opts.client,
      siteUrl: opts.siteUrl,
      table: 'search_appearance',
      startDate: opts.startDate,
      endDate: opts.endDate,
      domainFilter: opts.domainFilter,
      dataState: opts.dataState,
      rowLimit: opts.rowLimit,
      maxPages: opts.maxPages,
      cpuBudgetMs: opts.cpuBudgetMs,
      searchType: opts.searchType,
      initialStartRow: opts.continuation?.phase === 'discovery' ? opts.continuation.nextStartRow : undefined,
      onPage: opts.onPage,
      onBatch: async (rows) => {
        for (const row of rows) {
          const value = String(row.keys?.[0] ?? '')
          if (value)
            discovered.add(value)
        }
        await opts.onTotalBatch?.(rows)
      },
    })
    totalRows += discovery.totalRows
    metadata = discovery.metadata
    if (discovery.hasMore) {
      return {
        appearances: [...discovered],
        totalRows,
        hasMore: true,
        continuation: { phase: 'discovery', appearances: [...discovered], nextStartRow: discovery.nextStartRow },
        metadata,
      }
    }
    hasMore ||= discovery.hasMore
    appearances.splice(0, appearances.length, ...discovered)
  }

  const startIndex = opts.continuation?.phase === 'context' ? opts.continuation.appearanceIndex : 0
  const startRow = opts.continuation?.phase === 'context' ? opts.continuation.nextStartRow : 0
  for (let i = startIndex; i < appearances.length; i++) {
    const searchAppearance = appearances[i]!
    const context = await runGscSyncSlice({
      client: opts.client,
      siteUrl: opts.siteUrl,
      table,
      startDate: opts.startDate,
      endDate: opts.endDate,
      domainFilter: opts.domainFilter,
      dimensionFilters: [{ dimension: 'searchAppearance', expression: searchAppearance }],
      dataState: opts.dataState,
      rowLimit: opts.rowLimit,
      maxPages: opts.maxPages,
      cpuBudgetMs: opts.cpuBudgetMs,
      searchType: opts.searchType,
      initialStartRow: i === startIndex ? startRow : undefined,
      onPage: opts.onPage,
      onBatch: rows => opts.onContextBatch({ searchAppearance, table, rows }),
    })
    totalRows += context.totalRows
    metadata = context.metadata
    if (context.hasMore) {
      return {
        appearances,
        totalRows,
        hasMore: true,
        continuation: { phase: 'context', appearances, appearanceIndex: i, nextStartRow: context.nextStartRow },
        metadata,
      }
    }
    hasMore ||= context.hasMore
  }

  return { appearances, totalRows, hasMore, metadata }
}
