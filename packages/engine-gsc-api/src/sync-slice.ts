// Paging loop over GSC Search Analytics for a single (site, table, date-range,
// searchType) slice. Hosts inject the client + per-batch handler (e.g. row
// accumulator push or D1 upsert) + telemetry callback. Pure orchestration —
// no D1, no queue, no manifest.

import type { SearchType } from '@gscdump/engine'
import type { GoogleSearchConsoleClient, SearchAnalyticsQuery } from 'gscdump'

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

export interface RunGscSyncSliceOptions {
  client: GoogleSearchConsoleClient
  siteUrl: string
  /** One of the engine sync-fan tables. Drives the dimension list. */
  table: 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords'
  startDate: string
  endDate: string
  domainFilter?: SyncSliceDomainFilter | null
  /**
   * Invoked per GSC API page with the rows fetched. Return a promise; the
   *  loop awaits it before paging further. Throw inside to abort; AbortError /
   *  timeout messages are swallowed so the continuation can re-process.
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
}

const DIMENSIONS_BY_TABLE = {
  pages: ['page', 'date'],
  keywords: ['query', 'date'],
  countries: ['country', 'date'],
  devices: ['device', 'date'],
  page_keywords: ['page', 'query', 'date'],
} as const

function isTimeoutLike(err: unknown): boolean {
  if (!(err instanceof Error))
    return false
  return err.name === 'AbortError' || err.message?.includes('timeout') || err.message?.includes('aborted')
}

function buildDomainFilterGroups(filter: SyncSliceDomainFilter | null | undefined) {
  if (!filter?.domain)
    return undefined
  const rootDomain = filter.domain.replace(/^www\./, '')
  const escapedDomain = rootDomain.replace(/\./g, '\\.')
  const pattern = `^https?://(www\\.)?${escapedDomain}/`
  return [{
    filters: [{
      dimension: 'page' as const,
      operator: 'includingRegex' as const,
      expression: pattern,
    }],
  }]
}

export async function runGscSyncSlice(
  opts: RunGscSyncSliceOptions,
): Promise<RunGscSyncSliceResult> {
  const rowLimit = opts.rowLimit ?? 500
  const cpuBudgetMs = opts.cpuBudgetMs ?? 20_000
  const maxPages = opts.maxPages ?? Infinity
  const searchType: SearchType = opts.searchType ?? 'web'
  const dimensions = [...DIMENSIONS_BY_TABLE[opts.table]]
  const dimensionFilterGroups = buildDomainFilterGroups(opts.domainFilter)

  const loopStart = Date.now()
  let startRow = opts.initialStartRow ?? 0
  let totalRows = 0
  let pageCount = 0

  while (true) {
    if (pageCount >= maxPages)
      return { totalRows, hasMore: true, nextStartRow: startRow }
    if (Date.now() - loopStart >= cpuBudgetMs)
      return { totalRows, hasMore: true, nextStartRow: startRow }

    const query: SearchAnalyticsQuery = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions,
      rowLimit,
      startRow,
      dataState: 'all',
      type: searchType,
      ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
    }

    const response = await opts.client._rawQuery(opts.siteUrl, query).catch((err: unknown) => {
      if (isTimeoutLike(err))
        return null
      throw err
    })
    if (!response)
      return { totalRows, hasMore: true, nextStartRow: startRow }

    const rows = (response.rows ?? []) as GscApiRow[]
    totalRows += rows.length
    pageCount++
    opts.onPage?.({ searchType, rowsThisPage: rows.length })

    if (rows.length > 0) {
      await opts.onBatch(rows).catch((err: unknown) => {
        if (isTimeoutLike(err))
          return
        throw err
      })
    }

    if (rows.length < rowLimit)
      break
    startRow += rows.length
  }

  return { totalRows, hasMore: false, nextStartRow: startRow }
}
