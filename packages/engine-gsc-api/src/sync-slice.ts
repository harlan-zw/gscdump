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
   * Domain (eTLD+1 + subdomain) to scope the slice to — matches both
   *  `www.` and bare variants. Strip the protocol; the regex is built here.
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
}

export interface RunGscSearchAppearanceContextSliceResult {
  appearances: string[]
  totalRows: number
  hasMore: boolean
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

// Builds the GSC `dimensionFilterGroups` that scopes a slice to the registered
// host. A site is scoped to the EXACT host the user registered, never the whole
// GSC property — when a site maps to a broader `sc-domain:` property this `page`
// regex (`^https?://(www\.)?<domain>/`) intentionally excludes all subdomain
// traffic. This host-scoping is a DECISION (ADR-0033), not a bug — do not widen
// it to "match the GSC UI".
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
type SyncSliceApiFilter = {
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
    const rootDomain = domainFilter.domain.replace(/^www\./, '')
    const escapedDomain = rootDomain.replace(/\./g, '\\.')
    const pattern = `^https?://(www\\.)?${escapedDomain}/`
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
  const dataState: GscDataState = opts.dataState ?? 'all'
  const dimensionFilterGroups = buildDimensionFilterGroups(opts.domainFilter, opts.dimensionFilters)

  const loopStart = Date.now()
  let startRow = opts.initialStartRow ?? 0
  let totalRows = 0
  let pageCount = 0
  let metadata: GscSearchAnalyticsMetadata | undefined

  while (true) {
    if (pageCount >= maxPages)
      return { totalRows, hasMore: true, nextStartRow: startRow, metadata }
    if (Date.now() - loopStart >= cpuBudgetMs)
      return { totalRows, hasMore: true, nextStartRow: startRow, metadata }

    const query: SearchAnalyticsQuery = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions,
      rowLimit,
      startRow,
      dataState,
      type: searchType,
      ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
    }

    const response = await opts.client._rawQuery(opts.siteUrl, query).catch((err: unknown) => {
      if (isTimeoutLike(err))
        return null
      throw err
    })
    if (!response)
      return { totalRows, hasMore: true, nextStartRow: startRow, metadata }

    const rows = (response.rows ?? []) as GscApiRow[]
    totalRows += rows.length
    pageCount++
    if ((response as { metadata?: GscSearchAnalyticsMetadata }).metadata)
      metadata = (response as { metadata?: GscSearchAnalyticsMetadata }).metadata
    opts.onPage?.({ searchType, rowsThisPage: rows.length })

    if (rows.length > 0) {
      const batchTimedOut = await opts.onBatch(rows).then(() => false).catch((err: unknown) => {
        if (isTimeoutLike(err))
          return true
        throw err
      })
      // A timed-out durable write is ambiguous — the rows may never have been
      // persisted. Stop and return retry state at the CURRENT cursor so the
      // continuation re-processes this page, rather than advancing past it
      // (which would leave a silent gap). Mirrors the `_rawQuery` timeout path.
      if (batchTimedOut)
        return { totalRows: totalRows - rows.length, hasMore: true, nextStartRow: startRow, metadata }
    }

    if (rows.length < rowLimit)
      break
    startRow += rows.length
  }

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
  const appearances = opts.appearances?.slice() ?? []
  let totalRows = 0
  let hasMore = false

  if (!opts.appearances) {
    const discovered = new Set<string>()
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
    hasMore ||= discovery.hasMore
    appearances.push(...discovered)
  }

  for (const searchAppearance of appearances) {
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
      onPage: opts.onPage,
      onBatch: rows => opts.onContextBatch({ searchAppearance, table, rows }),
    })
    totalRows += context.totalRows
    hasMore ||= context.hasMore
  }

  return { appearances, totalRows, hasMore }
}
