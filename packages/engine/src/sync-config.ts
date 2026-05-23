// Engine-shaped sync configuration shared by host orchestrators.
// Host-side D1/queue/HTTP constants stay in the host (`D1_MAX_PARAMS`,
// `PROCESSING_TIMEOUT_MS`, etc).

import type { TableName } from '@gscdump/contracts'
import type { SearchType } from './storage'

// Per-searchType table fan-out for sync orchestration. `indexing` is
// intentionally absent — it's searchType-orthogonal and lives in its own
// pipeline. Non-Discover types mirror Discover's shape until verified
// against the GSC Search Analytics docs.
export type SyncTableName = Extract<TableName, 'pages' | 'queries' | 'countries' | 'page_queries' | 'dates' | 'search_appearance'>

export const TABLES_BY_SEARCH_TYPE: Record<SearchType, readonly SyncTableName[]> = {
  web: ['pages', 'queries', 'countries', 'page_queries', 'dates', 'search_appearance'],
  // Discover has no `query` dimension — drop query-bearing tables.
  discover: ['pages', 'countries', 'dates'],
  news: ['pages', 'countries', 'dates'],
  googleNews: ['pages', 'countries', 'dates'],
  image: ['pages', 'countries', 'dates'],
  video: ['pages', 'countries', 'dates'],
}

// Parse the persisted JSON column. Returns ['web'] for null/invalid/empty
// inputs and guarantees 'web' is present. Lenient: callers treat the result
// as authoritative for fan-out.
export function parseEnabledSearchTypes(raw: string | null | undefined): SearchType[] {
  if (!raw)
    return ['web']
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0)
    return ['web']
  const valid = parsed.filter((v): v is SearchType => typeof v === 'string' && v in TABLES_BY_SEARCH_TYPE)
  if (valid.length === 0)
    return ['web']
  if (!valid.includes('web'))
    valid.unshift('web')
  return valid
}

// Validate at write time. Throws so bad input surfaces rather than silently
// downgrading to ['web'].
export function validateEnabledSearchTypes(value: unknown): SearchType[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('enabledSearchTypes must be a non-empty array')
  const seen = new Set<string>()
  const out: SearchType[] = []
  for (const v of value) {
    if (typeof v !== 'string' || !(v in TABLES_BY_SEARCH_TYPE))
      throw new Error(`enabledSearchTypes: unknown searchType ${String(v)}`)
    if (seen.has(v))
      continue
    seen.add(v)
    out.push(v as SearchType)
  }
  if (!out.includes('web'))
    throw new Error('enabledSearchTypes must include "web"')
  return out
}

// Tiered sync table priority. Hosts use this to plan sync ordering.
export const TABLE_TIERS = {
  pages: 'critical',
  queries: 'critical',
  countries: 'standard',
  dates: 'standard',
  page_queries: 'extended',
} as const

export type TieredTableName = keyof typeof TABLE_TIERS
export type TableTier = 'critical' | 'standard' | 'extended'
export type DateWeight = 'fresh' | 'recent' | 'historical'

export function getTableTier(table: string): TableTier {
  return TABLE_TIERS[table as TieredTableName] || 'extended'
}

export function getTablesForTier(tier: TableTier): TieredTableName[] {
  return Object.entries(TABLE_TIERS)
    .filter(([_, t]) => t === tier)
    .map(([name]) => name as TieredTableName)
}

export function getDateWeight(date: string, now: Date = new Date()): DateWeight {
  const target = new Date(date)
  const daysAgo = Math.floor((now.getTime() - target.getTime()) / (1000 * 60 * 60 * 24))
  if (daysAgo <= 3)
    return 'fresh'
  if (daysAgo <= 60)
    return 'recent'
  return 'historical'
}

export const TIER_PRIORITY: Record<TableTier, number> = {
  critical: 0,
  standard: 1,
  extended: 2,
}

export const WEIGHT_PRIORITY: Record<DateWeight, number> = {
  fresh: 0,
  recent: 1,
  historical: 2,
}

// Sync ingest caps the engine cares about. Page sizes apply to the GSC API
// page size; row caps apply to the R2 write accumulator's per-job ceilings.
export const MAX_GSC_PAGES_R2 = 40
// GSC Search Analytics caps a single page at 25k rows. Larger pages mean
// fewer Iceberg appends (fewer catalog commits → less 429 contention),
// bigger parquet files (smaller small-file penalty), and 2.5× fewer GSC
// subrequests per job. ~7-8 MB held per page, well under the Worker budget.
export const ROW_LIMIT_R2 = 25_000

// Drop-thresholds for sync row filtering. Zero-impression rows are noise;
// long-tail country rows balloon write volume.
export const MIN_SYNC_IMPRESSIONS = 1
export const MIN_COUNTRY_IMPRESSIONS = 10

// Per-site sitemap URL caps. Beyond these caps hosts only retain counts/health.
export const MAX_SITEMAP_URLS_PER_SITE = 50_000
export const MAX_TRACKED_URLS_PER_SITE = 200_000
