import type { TenantCtx } from '@gscdump/contracts'

function tenantEntityPrefix(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities`
    : `u_${ctx.userId}/entities`
}

export function inspectionIndexKey(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/inspections/index.json`
}

export function emptyTypesKey(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/empty-types.json`
}

export function inspectionParquetKey(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/inspections/index.parquet`
}

export function inspectionEventsPrefix(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/inspections/events`
}

export function inspectionEventKey(ctx: TenantCtx, yearMonth: string, batchId: string): string {
  return `${inspectionEventsPrefix(ctx)}/${yearMonth}/${batchId}.parquet`
}

export function inspectionBaseKey(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/inspections/base.parquet`
}

export function inspectionHistoryPrefix(ctx: TenantCtx, yearMonth: string): string {
  return `${tenantEntityPrefix(ctx)}/inspections/history/${yearMonth}`
}

export function inspectionHistoryShardKey(ctx: TenantCtx, yearMonth: string, batchId: string): string {
  return `${inspectionHistoryPrefix(ctx, yearMonth)}/${batchId}.json`
}

/** Stable, URL-safe FNV-1a hash used for entity keys. */
export function hashUrl(url: string): string {
  let hi = 0x811C9DC5
  let lo = 0xCBF29CE4
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    lo ^= c
    const loMul = Math.imul(lo, 0x000001B3) >>> 0
    const carry = Math.floor((lo * 0x000001B3) / 0x100000000)
    const hiMul = (Math.imul(hi, 0x000001B3) + Math.imul(lo, 0x00000001) + carry) >>> 0
    lo = loMul
    hi = hiMul
  }
  return ((hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0'))
}

export function sitemapIndexKey(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/sitemaps/index.json`
}

export function sitemapHistoryKey(ctx: TenantCtx, feedpathHash: string, capturedAtMs: number): string {
  return `${tenantEntityPrefix(ctx)}/sitemaps/history/${feedpathHash}__${capturedAtMs}.json`
}

export function sitemapUrlsPrefix(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/sitemaps/urls`
}

export function sitemapUrlsIndexPrefix(ctx: TenantCtx): string {
  return `${sitemapUrlsPrefix(ctx)}/by-feed`
}

export function sitemapUrlsIndexKey(ctx: TenantCtx, feedpathHash: string): string {
  return `${sitemapUrlsIndexPrefix(ctx)}/${feedpathHash}/index.parquet`
}

export function sitemapUrlsDeltaKey(ctx: TenantCtx, feedpathHash: string, date: string): string {
  return `${sitemapUrlsPrefix(ctx)}/deltas/${date}__${feedpathHash}.parquet`
}

/** Hash a URL list for deterministic change detection. */
export function hashUrlList(urls: readonly { loc: string }[]): string {
  const locs = urls.map(url => url.loc).sort()
  return hashSortedUrlList(locs)
}

/** Hash sorted URL strings as though joined by a newline, without allocating the join. */
export function hashSortedUrlList(locs: readonly string[]): string {
  let hi = 0x811C9DC5
  let lo = 0xCBF29CE4
  for (let locIndex = 0; locIndex < locs.length; locIndex++) {
    const loc = locs[locIndex]!
    const length = loc.length + (locIndex < locs.length - 1 ? 1 : 0)
    for (let i = 0; i < length; i++) {
      const c = i < loc.length ? loc.charCodeAt(i) : 10
      lo ^= c
      const loMul = Math.imul(lo, 0x000001B3) >>> 0
      const carry = Math.floor((lo * 0x000001B3) / 0x100000000)
      const hiMul = (Math.imul(hi, 0x000001B3) + Math.imul(lo, 0x00000001) + carry) >>> 0
      lo = loMul
      hi = hiMul
    }
  }
  return ((hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0'))
}

export function indexingMetadataIndexKey(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/indexing/index.json`
}

function queryDimPrefix(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/query_dim`
}

export function queryDimParquetKey(ctx: TenantCtx): string {
  return `${queryDimPrefix(ctx)}/index.parquet`
}

export function queryDimMetaKey(ctx: TenantCtx): string {
  return `${queryDimPrefix(ctx)}/index.json`
}
