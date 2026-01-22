import type { GoogleSearchConsoleClient, GSCQueryBuilder } from 'gscdump'
import type { GoogleSearchConsoleDatabase } from './connector'
import type {
  SiteDateAnalyticsInsert,
  SiteDateCountryAnalyticsInsert,
  SiteDateDeviceAnalyticsInsert,
  SiteDateSearchAppearanceAnalyticsInsert,
  SiteInsert,
  SiteKeywordDateAnalyticsInsert,
  SiteKeywordPathDateAnalyticsInsert,
  SitePathDateAnalyticsInsert,
  SitePathIndexingSelect,
} from './schema'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { between, date, daysAgo, extractDateRange, gsc } from 'gscdump/query'
import { withoutProtocol, withoutTrailingSlash } from 'ufo'
import {
  siteDateAnalytics,
  siteDateCountryAnalytics,
  siteDateDeviceAnalytics,
  siteDateSearchAppearanceAnalytics,
  siteKeywordDateAnalytics,
  siteKeywordPathDateAnalytics,
  sitePathDateAnalytics,
  sitePathIndexing,
  sites,
} from './schema'

export type SyncTable = 'dates' | 'pages' | 'keywords' | 'keywordPaths' | 'countries' | 'devices' | 'searchAppearances'

export interface SyncOptions {
  /** Query builder with date range. Defaults to last 28 days */
  builder?: GSCQueryBuilder<any, any>
  /** Callback for each batch */
  onBatch?: (table: SyncTable, rows: any[], batchIndex: number) => void
}

export interface SyncResult {
  dates?: number
  pages?: number
  keywords?: number
  keywordPaths?: number
  countries?: number
  devices?: number
  searchAppearances?: number
  total: number
}

export function toGscMetrics(row: { clicks?: number | null, impressions?: number | null, ctr?: number | null, position?: number | null }): { clicks: number, impressions: number, ctr: number, position: number } {
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

function getDateFromBuilder(builder: GSCQueryBuilder<any, any>): string {
  const state = builder.getState()
  const { startDate } = extractDateRange(state.filters)
  return startDate || daysAgo(28)
}

function defaultBuilder(): GSCQueryBuilder<any, any> {
  return gsc.where(between(date, daysAgo(28), daysAgo(1)))
}

export async function syncSites(db: GoogleSearchConsoleDatabase, client: GoogleSearchConsoleClient): Promise<SiteInsert[]> {
  const allSites = await client.sites()
  const gscSites = allSites.filter((s): s is { siteUrl: string, permissionLevel: string } =>
    !!s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')

  const rowsToInsert: SiteInsert[] = []

  for (let idx = 0; idx < gscSites.length; idx++) {
    const site = gscSites[idx]
    const sitemaps = site.permissionLevel === 'siteOwner'
      ? (await client.sitemaps.list(site.siteUrl)).map(s => s.path).filter((p): p is string => !!p)
      : []

    rowsToInsert.push({
      siteId: idx + 1,
      property: site.siteUrl,
      domain: extractDomain(site.siteUrl),
      sitemaps,
    })
  }

  for (const row of rowsToInsert) {
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

  return rowsToInsert
}

export async function syncTables(
  db: GoogleSearchConsoleDatabase,
  client: GoogleSearchConsoleClient,
  siteId: number,
  siteUrl: string,
  tables: SyncTable[],
  options: SyncOptions = {},
): Promise<SyncResult> {
  const builder = options.builder ?? defaultBuilder()
  const dateStr = getDateFromBuilder(builder)
  const result: SyncResult = { total: 0 }

  for (const table of tables) {
    let batchIndex = 0

    if (table === 'dates') {
      const tableBuilder = builder.select('date')
      const rows: SiteDateAnalyticsInsert[] = []

      for await (const batch of client.query(siteUrl, tableBuilder)) {
        const mapped = batch.map(row => ({
          siteId,
          date: row.date,
          ...toGscMetrics(row),
        }))
        rows.push(...mapped)
        options.onBatch?.(table, mapped, batchIndex++)
      }

      for (const row of rows) {
        await db.insert(siteDateAnalytics)
          .values(row)
          .onConflictDoUpdate({
            target: [siteDateAnalytics.siteId, siteDateAnalytics.date],
            set: { ...toGscMetrics(row), updatedAt: Date.now() },
          })
      }

      result.dates = rows.length
      result.total += rows.length
    }

    if (table === 'pages') {
      const tableBuilder = builder.select('page')
      const rows: SitePathDateAnalyticsInsert[] = []

      for await (const batch of client.query(siteUrl, tableBuilder)) {
        const mapped = batch.map(row => ({
          siteId,
          date: dateStr,
          path: row.page.replace(/^https?:\/\/[^/]+/, ''),
          ...toGscMetrics(row),
        }))
        rows.push(...mapped)
        options.onBatch?.(table, mapped, batchIndex++)
      }

      for (const row of rows) {
        await db.insert(sitePathDateAnalytics)
          .values(row)
          .onConflictDoUpdate({
            target: [sitePathDateAnalytics.siteId, sitePathDateAnalytics.date, sitePathDateAnalytics.path],
            set: { ...toGscMetrics(row), updatedAt: Date.now() },
          })
      }

      result.pages = rows.length
      result.total += rows.length
    }

    if (table === 'keywords') {
      const tableBuilder = builder.select('query')
      const rows: SiteKeywordDateAnalyticsInsert[] = []

      for await (const batch of client.query(siteUrl, tableBuilder)) {
        const mapped = batch.map(row => ({
          siteId,
          date: dateStr,
          keyword: row.query,
          ...toGscMetrics(row),
        }))
        rows.push(...mapped)
        options.onBatch?.(table, mapped, batchIndex++)
      }

      for (const row of rows) {
        await db.insert(siteKeywordDateAnalytics)
          .values(row)
          .onConflictDoUpdate({
            target: [siteKeywordDateAnalytics.siteId, siteKeywordDateAnalytics.date, siteKeywordDateAnalytics.keyword],
            set: { ...toGscMetrics(row), updatedAt: Date.now() },
          })
      }

      result.keywords = rows.length
      result.total += rows.length
    }

    if (table === 'keywordPaths') {
      const tableBuilder = builder.select('query', 'page')
      const rows: SiteKeywordPathDateAnalyticsInsert[] = []

      for await (const batch of client.query(siteUrl, tableBuilder)) {
        const mapped = batch.map(row => ({
          siteId,
          date: dateStr,
          keyword: row.query,
          path: row.page.replace(/^https?:\/\/[^/]+/, ''),
          ...toGscMetrics(row),
        }))
        rows.push(...mapped)
        options.onBatch?.(table, mapped, batchIndex++)
      }

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
            set: { ...toGscMetrics(row), updatedAt: Date.now() },
          })
      }

      result.keywordPaths = rows.length
      result.total += rows.length
    }

    if (table === 'countries') {
      const tableBuilder = builder.select('country')
      const rows: SiteDateCountryAnalyticsInsert[] = []

      for await (const batch of client.query(siteUrl, tableBuilder)) {
        const mapped = batch.map(row => ({
          siteId,
          date: dateStr,
          country: row.country,
          ...toGscMetrics(row),
        }))
        rows.push(...mapped)
        options.onBatch?.(table, mapped, batchIndex++)
      }

      for (const row of rows) {
        await db.insert(siteDateCountryAnalytics)
          .values(row)
          .onConflictDoUpdate({
            target: [siteDateCountryAnalytics.siteId, siteDateCountryAnalytics.date, siteDateCountryAnalytics.country],
            set: { ...toGscMetrics(row), updatedAt: Date.now() },
          })
      }

      result.countries = rows.length
      result.total += rows.length
    }

    if (table === 'devices') {
      const tableBuilder = builder.select('device')
      const rows: SiteDateDeviceAnalyticsInsert[] = []

      for await (const batch of client.query(siteUrl, tableBuilder)) {
        const mapped = batch.map(row => ({
          siteId,
          date: dateStr,
          device: row.device,
          ...toGscMetrics(row),
        }))
        rows.push(...mapped)
        options.onBatch?.(table, mapped, batchIndex++)
      }

      for (const row of rows) {
        await db.insert(siteDateDeviceAnalytics)
          .values(row)
          .onConflictDoUpdate({
            target: [siteDateDeviceAnalytics.siteId, siteDateDeviceAnalytics.date, siteDateDeviceAnalytics.device],
            set: { ...toGscMetrics(row), updatedAt: Date.now() },
          })
      }

      result.devices = rows.length
      result.total += rows.length
    }

    if (table === 'searchAppearances') {
      const tableBuilder = builder.select('searchAppearance')
      const rows: SiteDateSearchAppearanceAnalyticsInsert[] = []

      for await (const batch of client.query(siteUrl, tableBuilder)) {
        const mapped = batch.map(row => ({
          siteId,
          date: dateStr,
          searchAppearance: row.searchAppearance,
          ...toGscMetrics(row),
        }))
        rows.push(...mapped)
        options.onBatch?.(table, mapped, batchIndex++)
      }

      for (const row of rows) {
        await db.insert(siteDateSearchAppearanceAnalytics)
          .values(row)
          .onConflictDoUpdate({
            target: [siteDateSearchAppearanceAnalytics.siteId, siteDateSearchAppearanceAnalytics.date, siteDateSearchAppearanceAnalytics.searchAppearance],
            set: { ...toGscMetrics(row), updatedAt: Date.now() },
          })
      }

      result.searchAppearances = rows.length
      result.total += rows.length
    }
  }

  await updateLastSynced(db, siteId)
  return result
}

export async function updateLastSynced(db: GoogleSearchConsoleDatabase, siteId: number): Promise<void> {
  await db.update(sites)
    .set({ lastSynced: Date.now() })
    .where(eq(sites.siteId, siteId))
}

export async function getLastSyncedDate(db: GoogleSearchConsoleDatabase, siteId: number): Promise<string | null> {
  const result = await db.select()
    .from(sites)
    .where(eq(sites.siteId, siteId))
    .limit(1)

  // @ts-expect-error set by d0
  const lastSynced = result[0]?.lastSynced || result[0]?.last_synced

  if (!result || result.length === 0 || !lastSynced)
    return null

  return new Date(lastSynced).toISOString().split('T')[0]
}

// === Indexing Status Functions ===

export type IndexingNotificationType = 'URL_UPDATED' | 'URL_DELETED'

export interface IndexingResult {
  url: string
  type: IndexingNotificationType
  notifyTime?: string | null
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
  db: GoogleSearchConsoleDatabase,
  siteId: number,
  options: {
    onlyNotIndexed?: boolean
    maxAge?: number // ms since last inspection
    limit?: number
  } = {},
): Promise<SitePathIndexingSelect[]> {
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
  db: GoogleSearchConsoleDatabase,
  client: GoogleSearchConsoleClient,
  siteId: number,
  property: string,
  path: string,
): Promise<{ isIndexed: boolean, error?: string }> {
  const fullUrl = buildFullUrl(property, path)

  const response = await client.inspect(property, fullUrl)
    .catch((e: Error) => ({ inspectionResult: undefined, error: e.message }))

  const inspection = 'inspectionResult' in response ? response.inspectionResult : undefined
  const isIndexed = inspection?.indexStatusResult?.verdict === 'PASS'
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
  db: GoogleSearchConsoleDatabase,
  client: GoogleSearchConsoleClient,
  siteId: number,
  property: string,
  path: string,
  type: IndexingNotificationType = 'URL_UPDATED',
): Promise<IndexingResult> {
  const fullUrl = buildFullUrl(property, path)

  const result = await client.indexing.publish(fullUrl, type)
    .then(res => ({ url: fullUrl, type, notifyTime: res.urlNotificationMetadata?.latestUpdate?.notifyTime }))
    .catch((e: Error) => ({ url: fullUrl, type, error: e.message }))

  const errorMsg = 'error' in result ? result.error : null

  await db.insert(sitePathIndexing)
    .values({
      siteId,
      path,
      lastIndexRequested: Date.now(),
      lastIndexRequestType: type,
      lastIndexRequestError: errorMsg,
    })
    .onConflictDoUpdate({
      target: [sitePathIndexing.siteId, sitePathIndexing.path],
      set: {
        lastIndexRequested: Date.now(),
        lastIndexRequestType: type,
        lastIndexRequestError: errorMsg,
        updatedAt: Date.now(),
      },
    })

  return {
    url: fullUrl,
    type,
    notifyTime: 'notifyTime' in result ? result.notifyTime : undefined,
    error: errorMsg ?? undefined,
  }
}

export async function batchInspectUrls(
  db: GoogleSearchConsoleDatabase,
  client: GoogleSearchConsoleClient,
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
    const result = await inspectAndSyncUrl(db, client, siteId, property, paths[i])
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
  db: GoogleSearchConsoleDatabase,
  client: GoogleSearchConsoleClient,
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
    const result = await requestAndSyncIndexing(db, client, siteId, property, paths[i], type)

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

export async function getIndexingStats(db: GoogleSearchConsoleDatabase, siteId: number): Promise<{ total: number, indexed: number, notIndexed: number, unknown: number, requested: number, rows: SitePathIndexingSelect[] }> {
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
