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

/**
 * Append-only record of URL-inspection STATE CHANGES, partitioned by month.
 *
 * Distinct from `events/`, which compaction deletes. Google exposes no API for
 * historical index-coverage state, so a verdict change observed once is gone
 * the moment the event file folds — this is the only durable record that a URL
 * ever left (or entered) the index.
 */
export function inspectionTransitionsPrefix(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/inspections/transitions`
}

/** One file per calendar month (`YYYY-MM`), rewritten in place as it fills. */
export function inspectionTransitionsMonthKey(ctx: TenantCtx, yearMonth: string): string {
  return `${inspectionTransitionsPrefix(ctx)}/${yearMonth}.parquet`
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

export function sitemapUrlsPrefix(ctx: TenantCtx): string {
  return `${tenantEntityPrefix(ctx)}/sitemaps/urls`
}

export interface SitemapGenerationKey {
  id: string
  observedAt: number
}

function sitemapGenerationDate(generation: SitemapGenerationKey): string {
  return new Date(generation.observedAt).toISOString().slice(0, 10)
}

export function sitemapUrlsEventsPrefix(ctx: TenantCtx): string {
  return `${sitemapUrlsPrefix(ctx)}/events`
}

export function sitemapUrlsEventKey(
  ctx: TenantCtx,
  feedpathHash: string,
  generation: SitemapGenerationKey,
): string {
  return `${sitemapUrlsEventsPrefix(ctx)}/${sitemapGenerationDate(generation)}__${feedpathHash}__${String(generation.observedAt).padStart(13, '0')}__${hashUrl(generation.id)}.parquet`
}

export function sitemapSiteManifestKey(ctx: TenantCtx): string {
  return `${sitemapUrlsPrefix(ctx)}/site-manifest.json`
}

export function sitemapSiteManifestsPrefix(ctx: TenantCtx): string {
  return `${sitemapUrlsPrefix(ctx)}/site-manifests`
}

export function sitemapSiteGenerationManifestKey(ctx: TenantCtx, generation: SitemapGenerationKey): string {
  return `${sitemapSiteManifestsPrefix(ctx)}/${String(generation.observedAt).padStart(13, '0')}__${hashUrl(generation.id)}.json`
}

export function sitemapStagedGenerationPrefix(ctx: TenantCtx, generation: SitemapGenerationKey): string {
  return `${sitemapUrlsPrefix(ctx)}/staged/${String(generation.observedAt).padStart(13, '0')}__${hashUrl(generation.id)}`
}

export function sitemapStagedFeedKey(
  ctx: TenantCtx,
  generation: SitemapGenerationKey,
  feedpathHash: string,
): string {
  return `${sitemapStagedGenerationPrefix(ctx, generation)}/${feedpathHash}.json`
}

export function sitemapImmutableBaseKey(
  ctx: TenantCtx,
  generation: SitemapGenerationKey,
  feedpathHash: string,
): string {
  return `${sitemapUrlsPrefix(ctx)}/bases/${feedpathHash}/${String(generation.observedAt).padStart(13, '0')}__${hashUrl(generation.id)}.parquet`
}

export function sitemapLegacyImportKey(ctx: TenantCtx): string {
  return `${sitemapUrlsPrefix(ctx)}/legacy-import.json`
}

/** WHATWG-serialized HTTP(S) feed identity with the fragment removed. */
export type SitemapFeedIdentityResult
  = | { _tag: 'ok', url: string }
    | { _tag: 'invalid', reason: 'credentials' | 'empty' | 'invalid_url' | 'unsupported_protocol' }

export function parseSitemapFeedIdentity(input: string): SitemapFeedIdentityResult {
  if (!input)
    return { _tag: 'invalid', reason: 'empty' }
  let parsed: URL
  try {
    parsed = new URL(input)
  }
  catch {
    return { _tag: 'invalid', reason: 'invalid_url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { _tag: 'invalid', reason: 'unsupported_protocol' }
  if (parsed.username || parsed.password)
    return { _tag: 'invalid', reason: 'credentials' }
  parsed.hash = ''
  return { _tag: 'ok', url: parsed.toString() }
}

/** Versioned exact payload hash. Lastmod-only changes are intentionally visible. */
export function sitemapPayloadHashV1(urls: readonly { loc: string, lastmod?: string }[]): string {
  const byLoc = new Map<string, string | null>()
  for (const url of urls)
    byLoc.set(url.loc, url.lastmod ?? null)
  const records = [...byLoc]
    .map(([loc, lastmod]) => JSON.stringify([loc, lastmod]))
    .sort()
  return `v1:${hashSortedUrlList(records)}`
}

/** Hash sorted URL strings as though joined by a newline, without allocating the join. */
function hashSortedUrlList(locs: readonly string[]): string {
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
