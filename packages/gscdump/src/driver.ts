/**
 * Driver contracts: cross-package shapes returned by GSC API drivers
 * (live REST, cloud-bridged, in-memory test doubles). Consumers (cloud SDK,
 * MCP server, test fixtures) bind against these contracts so a driver swap
 * doesn't ripple through call sites.
 *
 * Edge-safe: no engine imports, no `node:*`. Driver shapes describe data
 * returned over the wire, so they belong with the REST client surface, not
 * the storage engine.
 */

export interface DriverSite {
  siteUrl: string
  permissionLevel: string
}

export interface DriverSiteWithSync extends DriverSite {
  siteId: string
  syncStatus: string | null
  syncProgress: { total: number, completed: number, percent: number }
  lastSyncAt: number | null
  newestDateSynced: string | null
  oldestDateSynced: string | null
}

export interface DriverQueryParams {
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
  startRow?: number
  searchType?: string
  filters?: Array<{ dimension: string, operator: string, expression: string }>
}

export interface DriverQueryRow {
  clicks: number
  impressions: number
  ctr: number
  position: number
  [key: string]: unknown
}

export interface DriverQueryResult {
  rows: DriverQueryRow[]
  meta: {
    siteUrl: string
    dimensions: string[]
    dateRange: { startDate: string, endDate: string }
    rowCount: number
    hasMore: boolean
  }
}

export interface DriverSitemap {
  path: string
  type?: string
  isPending?: boolean
  errors?: number
  warnings?: number
  urlCount?: number
  lastDownloaded?: string | null
}

export interface DriverInspectResult {
  url: string
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  lastCrawlTime: string | null
  isIndexed: boolean
  raw: unknown
}
