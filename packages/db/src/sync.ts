import type { OAuth2Client } from 'google-auth-library'
import type { ResolvedAnalyticsRange } from 'gscdump'
import type { GscDb } from './connector'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import {
  createQueryBody,
  fetchCountriesWithComparison,
  fetchDevicesWithComparison,
  fetchGscSitesWithSitemaps,
  fetchKeywordsWithComparison,
  fetchPagesWithComparison,
  inspectGscUrl,
  queryRecursive,
} from 'gscdump'
import { withoutProtocol, withoutTrailingSlash } from 'ufo'
import {
  siteDateCountryAnalytics,
  siteDateDeviceAnalytics,
  siteKeywordDateAnalytics,
  siteKeywordPathDateAnalytics,
  sitePathDateAnalytics,
  sitePathIndexing,
  sites,
} from './schema'

function toGscMetrics(row: { clicks?: number | null, impressions?: number | null, ctr?: number | null, position?: number | null }) {
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: Math.round((row.ctr ?? 0) * 10000),
    position: Math.round((row.position ?? 0) * 100),
  }
}

function extractDomain(property: string): string {
  if (property.startsWith('sc-domain:'))
    return property.replace('sc-domain:', '')
  return withoutTrailingSlash(withoutProtocol(property))
}

export async function syncSites(db: GscDb, auth: OAuth2Client) {
  const gscSites = await fetchGscSitesWithSitemaps(auth)
  const rows = gscSites.map((site, idx) => ({
    siteId: idx + 1,
    property: site.siteUrl,
    domain: extractDomain(site.siteUrl),
    sitemaps: site.sitemaps.map(s => s.path).filter((p): p is string => !!p),
  }))

  for (const row of rows) {
    await db.insert(sites)
      .values(row)
      .onConflictDoUpdate({
        target: sites.property,
        set: {
          domain: row.domain,
          sitemaps: row.sitemaps,
          updatedAt: Date.now(),
        },
      })
  }

  return rows
}

export async function syncPages(db: GscDb, auth: OAuth2Client, siteId: number, siteUrl: string, range: ResolvedAnalyticsRange) {
  const { current } = await fetchPagesWithComparison(auth, siteUrl, range)
  const date = typeof range.period.start === 'string'
    ? range.period.start
    : range.period.start.toISOString().split('T')[0]

  const rows = current.map(row => ({
    siteId,
    date,
    path: row.page.replace(/^https?:\/\/[^/]+/, ''),
    ...toGscMetrics(row),
  }))

  for (const row of rows) {
    await db.insert(sitePathDateAnalytics)
      .values(row)
      .onConflictDoUpdate({
        target: [sitePathDateAnalytics.siteId, sitePathDateAnalytics.date, sitePathDateAnalytics.path],
        set: {
          ...toGscMetrics(row),
          updatedAt: Date.now(),
        },
      })
  }

  return rows
}

export async function syncKeywords(db: GscDb, auth: OAuth2Client, siteId: number, siteUrl: string, range: ResolvedAnalyticsRange) {
  const { current } = await fetchKeywordsWithComparison(auth, siteUrl, range)
  const date = typeof range.period.start === 'string'
    ? range.period.start
    : range.period.start.toISOString().split('T')[0]

  const rows = current.map(row => ({
    siteId,
    date,
    keyword: row.keyword,
    ...toGscMetrics(row),
  }))

  for (const row of rows) {
    await db.insert(siteKeywordDateAnalytics)
      .values(row)
      .onConflictDoUpdate({
        target: [siteKeywordDateAnalytics.siteId, siteKeywordDateAnalytics.date, siteKeywordDateAnalytics.keyword],
        set: {
          ...toGscMetrics(row),
          updatedAt: Date.now(),
        },
      })
  }

  return rows
}

export async function syncCountries(db: GscDb, auth: OAuth2Client, siteId: number, siteUrl: string, range: ResolvedAnalyticsRange) {
  const { current } = await fetchCountriesWithComparison(auth, siteUrl, range)
  const date = typeof range.period.start === 'string'
    ? range.period.start
    : range.period.start.toISOString().split('T')[0]

  const rows = current.map(row => ({
    siteId,
    date,
    country: row.countryCodeGsc,
    ...toGscMetrics(row),
  }))

  for (const row of rows) {
    await db.insert(siteDateCountryAnalytics)
      .values(row)
      .onConflictDoUpdate({
        target: [siteDateCountryAnalytics.siteId, siteDateCountryAnalytics.date, siteDateCountryAnalytics.country],
        set: {
          ...toGscMetrics(row),
          updatedAt: Date.now(),
        },
      })
  }

  return rows
}

export async function syncDevices(db: GscDb, auth: OAuth2Client, siteId: number, siteUrl: string, range: ResolvedAnalyticsRange) {
  const { current } = await fetchDevicesWithComparison(auth, siteUrl, range)
  const date = typeof range.period.start === 'string'
    ? range.period.start
    : range.period.start.toISOString().split('T')[0]

  const rows = current.map(row => ({
    siteId,
    date,
    device: row.device,
    ...toGscMetrics(row),
  }))

  for (const row of rows) {
    await db.insert(siteDateDeviceAnalytics)
      .values(row)
      .onConflictDoUpdate({
        target: [siteDateDeviceAnalytics.siteId, siteDateDeviceAnalytics.date, siteDateDeviceAnalytics.device],
        set: {
          ...toGscMetrics(row),
          updatedAt: Date.now(),
        },
      })
  }

  return rows
}

export async function syncKeywordPaths(db: GscDb, auth: OAuth2Client, siteId: number, siteUrl: string, range: ResolvedAnalyticsRange) {
  const date = typeof range.period.start === 'string'
    ? range.period.start
    : range.period.start.toISOString().split('T')[0]

  // Fetch keyword+page combinations (most granular data)
  const { data } = await queryRecursive(auth, siteUrl, {
    ...createQueryBody({ period: range.period }),
    dimensions: ['query', 'page'],
  })

  const rows = (data.rows || []).map(row => ({
    siteId,
    date,
    keyword: row.keys?.[0] || '',
    path: (row.keys?.[1] || '').replace(/^https?:\/\/[^/]+/, ''),
    ...toGscMetrics(row),
  }))

  for (const row of rows) {
    await db.insert(siteKeywordPathDateAnalytics)
      .values(row)
      .onConflictDoUpdate({
        target: [
          siteKeywordPathDateAnalytics.siteId,
          siteKeywordPathDateAnalytics.date,
          siteKeywordPathDateAnalytics.keyword,
          siteKeywordPathDateAnalytics.path,
        ],
        set: {
          ...toGscMetrics(row),
          updatedAt: Date.now(),
        },
      })
  }

  return rows
}

export async function updateLastSynced(db: GscDb, siteId: number) {
  await db.update(sites)
    .set({ lastSynced: Date.now() })
    .where(eq(sites.siteId, siteId))
}

export async function getLastSyncedDate(db: GscDb, siteId: number): Promise<string | null> {
  const result = await db.select({ lastSynced: sites.lastSynced })
    .from(sites)
    .where(eq(sites.siteId, siteId))
    .limit(1)

  const lastSynced = result[0]?.lastSynced
  if (!lastSynced)
    return null

  // Convert ms timestamp to YYYY-MM-DD
  const { default: dayjs } = await import('dayjs')
  return dayjs(lastSynced).format('YYYY-MM-DD')
}

export async function syncAll(db: GscDb, auth: OAuth2Client, siteId: number, siteUrl: string, range: ResolvedAnalyticsRange) {
  await Promise.all([
    syncPages(db, auth, siteId, siteUrl, range),
    syncKeywords(db, auth, siteId, siteUrl, range),
    syncCountries(db, auth, siteId, siteUrl, range),
    syncDevices(db, auth, siteId, siteUrl, range),
  ])
  await updateLastSynced(db, siteId)
}

export async function syncAllWithKeywordPaths(db: GscDb, auth: OAuth2Client, siteId: number, siteUrl: string, range: ResolvedAnalyticsRange) {
  await Promise.all([
    syncPages(db, auth, siteId, siteUrl, range),
    syncKeywords(db, auth, siteId, siteUrl, range),
    syncKeywordPaths(db, auth, siteId, siteUrl, range),
    syncCountries(db, auth, siteId, siteUrl, range),
    syncDevices(db, auth, siteId, siteUrl, range),
  ])
  await updateLastSynced(db, siteId)
}

// === Indexing Status Functions ===

export type IndexingNotificationType = 'URL_UPDATED' | 'URL_DELETED'

export interface IndexingResult {
  url: string
  type: IndexingNotificationType
  notifyTime?: string
  error?: string
}

function buildFullUrl(property: string, path: string): string {
  if (property.startsWith('sc-domain:')) {
    const domain = property.replace('sc-domain:', '')
    return `https://${domain}${path}`
  }
  return `${property.replace(/\/$/, '')}${path}`
}

export async function getUrlsNeedingIndexing(
  db: GscDb,
  siteId: number,
  options: {
    onlyNotIndexed?: boolean
    maxAge?: number // ms since last inspection
    limit?: number
  } = {},
) {
  const { onlyNotIndexed = true, maxAge, limit } = options
  const now = Date.now()

  const conditions = [eq(sitePathIndexing.siteId, siteId)]

  if (onlyNotIndexed) {
    conditions.push(or(
      eq(sitePathIndexing.isIndexed, false),
      isNull(sitePathIndexing.isIndexed),
    )!)
  }

  if (maxAge) {
    const cutoff = now - maxAge
    conditions.push(or(
      isNull(sitePathIndexing.lastInspected),
      lt(sitePathIndexing.lastInspected, cutoff),
    )!)
  }

  const query = db.select().from(sitePathIndexing).where(and(...conditions))

  if (limit)
    return query.limit(limit)

  return query
}

export async function inspectAndSyncUrl(
  db: GscDb,
  auth: OAuth2Client,
  siteId: number,
  property: string,
  path: string,
): Promise<{ isIndexed: boolean, error?: string }> {
  const fullUrl = buildFullUrl(property, path)

  const { inspection, isIndexed } = await inspectGscUrl(auth, property, fullUrl)
    .catch((e: Error) => ({ inspection: undefined, isIndexed: false, error: e.message }))

  const indexStatus = inspection?.indexStatusResult

  await db.insert(sitePathIndexing)
    .values({
      siteId,
      path,
      isIndexed,
      indexVerdict: indexStatus?.verdict || null,
      coverageState: indexStatus?.coverageState || null,
      robotsTxtState: indexStatus?.robotsTxtState || null,
      indexingState: indexStatus?.indexingState || null,
      lastInspected: Date.now(),
    })
    .onConflictDoUpdate({
      target: [sitePathIndexing.siteId, sitePathIndexing.path],
      set: {
        isIndexed,
        indexVerdict: indexStatus?.verdict || null,
        coverageState: indexStatus?.coverageState || null,
        robotsTxtState: indexStatus?.robotsTxtState || null,
        indexingState: indexStatus?.indexingState || null,
        lastInspected: Date.now(),
        updatedAt: Date.now(),
      },
    })

  return { isIndexed }
}

export async function requestAndSyncIndexing(
  db: GscDb,
  auth: OAuth2Client,
  siteId: number,
  property: string,
  path: string,
  type: IndexingNotificationType = 'URL_UPDATED',
): Promise<IndexingResult> {
  const { batchRequestIndexing } = await import('gscdump')
  const fullUrl = buildFullUrl(property, path)

  const [result] = await batchRequestIndexing(auth, [fullUrl], { type })

  await db.insert(sitePathIndexing)
    .values({
      siteId,
      path,
      lastIndexRequested: Date.now(),
      lastIndexRequestType: type,
      lastIndexRequestError: result.error || null,
    })
    .onConflictDoUpdate({
      target: [sitePathIndexing.siteId, sitePathIndexing.path],
      set: {
        lastIndexRequested: Date.now(),
        lastIndexRequestType: type,
        lastIndexRequestError: result.error || null,
        updatedAt: Date.now(),
      },
    })

  return result
}

export async function batchInspectUrls(
  db: GscDb,
  auth: OAuth2Client,
  siteId: number,
  property: string,
  paths: string[],
  options: {
    delayMs?: number
    onProgress?: (result: { path: string, isIndexed: boolean, error?: string }, index: number, total: number) => void
  } = {},
): Promise<{ indexed: number, notIndexed: number, errors: number }> {
  const { delayMs = 200, onProgress } = options
  let indexed = 0
  let notIndexed = 0
  let errors = 0

  for (let i = 0; i < paths.length; i++) {
    const result = await inspectAndSyncUrl(db, auth, siteId, property, paths[i])
      .catch((e: Error) => ({ isIndexed: false, error: e.message }))

    if (result.error)
      errors++
    else if (result.isIndexed)
      indexed++
    else
      notIndexed++

    onProgress?.({ path: paths[i], ...result }, i, paths.length)

    if (i < paths.length - 1 && delayMs > 0)
      await new Promise(r => setTimeout(r, delayMs))
  }

  return { indexed, notIndexed, errors }
}

export async function batchRequestIndexingForPaths(
  db: GscDb,
  auth: OAuth2Client,
  siteId: number,
  property: string,
  paths: string[],
  options: {
    type?: IndexingNotificationType
    delayMs?: number
    onProgress?: (result: IndexingResult, index: number, total: number) => void
  } = {},
): Promise<{ success: number, errors: number }> {
  const { type = 'URL_UPDATED', delayMs = 100, onProgress } = options
  let success = 0
  let errors = 0

  for (let i = 0; i < paths.length; i++) {
    const result = await requestAndSyncIndexing(db, auth, siteId, property, paths[i], type)

    if (result.error)
      errors++
    else
      success++

    onProgress?.(result, i, paths.length)

    if (i < paths.length - 1 && delayMs > 0)
      await new Promise(r => setTimeout(r, delayMs))
  }

  return { success, errors }
}

export async function getIndexingStats(db: GscDb, siteId: number) {
  const rows = await db.select().from(sitePathIndexing).where(eq(sitePathIndexing.siteId, siteId))

  const indexed = rows.filter(r => r.isIndexed === true).length
  const notIndexed = rows.filter(r => r.isIndexed === false).length
  const unknown = rows.filter(r => r.isIndexed === null).length
  const requested = rows.filter(r => r.lastIndexRequested !== null).length

  return {
    total: rows.length,
    indexed,
    notIndexed,
    unknown,
    requested,
    rows,
  }
}
