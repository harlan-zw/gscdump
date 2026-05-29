/**
 * Object-storage layout — the pure functions that compute where data lives
 * and read that encoding back. Partition names (`daily/`, `hourly/`,
 * `weekly/`, `monthly/`, `quarterly/`), the tenant object-key assembly
 * (`u_<user>/<site>/<table>/<type>/<partition>__v<n>.parquet`), and the
 * inverse inference helpers (`inferSearchType`, `inferLegacyTier`).
 *
 * Pure and dependency-light (date math from `gscdump`; contract/manifest
 * types only). The storage *contract* (interfaces like `ManifestStore`,
 * `DataSource`, `StorageEngine`) lives in `./storage`; this module is its
 * computational primitive and never imports a value from it.
 */
import type { TableName, TenantCtx } from '@gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { CompactionTier, ManifestEntry } from './storage'
import { MS_PER_DAY, toIsoDate } from 'gscdump'

export function dayPartition(date: string): string {
  return `daily/${date}`
}
/**
 * Hourly partition keyed by the PT calendar day (`YYYY-MM-DD`). One parquet
 * per day holds 24 hourly buckets — read-merge-write keeps `(url, hour)`
 * idempotency across retries. Names sort lexically alongside daily ones but
 * never collide because of the `hourly/` prefix.
 */
export function hourPartition(date: string): string {
  return `hourly/${date}`
}
export function monthPartition(month: string): string {
  return `monthly/${month}`
}
/**
 * Weekly partition keyed by the Monday-of-week ISO date (e.g. `weekly/2026-04-20`
 * for the ISO week containing 2026-04-22). Names are stable + sortable; the
 * dashboard never parses them, only reads via the manifest.
 */
export function weekPartition(mondayIsoDate: string): string {
  return `weekly/${mondayIsoDate}`
}
/**
 * Quarterly partition (e.g. `quarterly/2026-Q2` for Apr-Jun 2026). Used as the
 * cold-tier shape for `d90` compaction outputs.
 */
export function quarterPartition(quarter: string): string {
  return `quarterly/${quarter}`
}
/**
 * Monday-of-week as a YYYY-MM-DD string for the ISO week containing `isoDate`.
 * Used by tiered compaction to bucket raw daily files into weekly groups.
 */
export function mondayOfWeek(isoDate: string): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`)
  const dow = new Date(ms).getUTCDay() // 0=Sun, 1=Mon, ... 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow
  return toIsoDate(new Date(ms + offset * MS_PER_DAY))
}
/** YYYY-Qq for the quarter containing the given YYYY-MM month string. */
export function quarterOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const q = Math.floor((m - 1) / 3) + 1
  return `${y}-Q${q}`
}
export function tenantPrefix(ctx: TenantCtx): string {
  return ctx.siteId ? `u_${ctx.userId}/${ctx.siteId}/` : `u_${ctx.userId}/`
}
/**
 * Default `searchType` for entries written before the field landed and for
 * sync paths that don't request a specific type. GSC's own default; the
 * vast majority of stored data is web-search.
 */
export const DEFAULT_SEARCH_TYPE: SearchType = 'web'
export function objectKey(
  ctx: TenantCtx,
  table: TableName,
  partition: string,
  version: number,
  searchType?: SearchType,
): string {
  const prefix = ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/${table}`
    : `u_${ctx.userId}/${table}`
  // Web is the implicit default and stays at the legacy path so old data
  // (and any reader that doesn't know about searchType) keeps working.
  // Non-web types get an extra path segment so they can never collide with
  // web files in the same partition.
  const typeSegment = searchType !== undefined && searchType !== DEFAULT_SEARCH_TYPE ? `${searchType}/` : ''
  return `${prefix}/${typeSegment}${partition}__v${version}.parquet`
}
/**
 * Resolve the search type for an entry, defaulting legacy entries to `web`.
 * Use this anywhere code needs to bucket entries by searchType.
 */
export function inferSearchType(entry: Pick<ManifestEntry, 'searchType'>): SearchType {
  return entry.searchType ?? DEFAULT_SEARCH_TYPE
}
/**
 * Infer the tier for an entry that pre-dates the `tier` field. Daily files
 * are `raw`; monthly files are `d30`. Anything else (already migrated, or
 * a partition shape we haven't seen) returns undefined and the caller must
 * decide how to handle it.
 */
export function inferLegacyTier(entry: Pick<ManifestEntry, 'partition' | 'tier'>): CompactionTier | undefined {
  if (entry.tier !== undefined)
    return entry.tier
  if (entry.partition.startsWith('daily/'))
    return 'raw'
  if (entry.partition.startsWith('monthly/'))
    return 'd30'
  return undefined
}
