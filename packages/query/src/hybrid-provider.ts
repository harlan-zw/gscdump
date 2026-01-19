import type { DateRange, GscDb, SiteDateCountryAnalyticsInsert, SiteDateDeviceAnalyticsInsert, SiteKeywordDateAnalyticsInsert, SitePathDateAnalyticsInsert } from '@gscdump/db'
import type { Auth } from 'gscdump'
import type { DataProvider } from './types'
import {
  getSiteByProperty,
  hasDataForRange,
  insertCountries,
  insertDevices,
  insertKeywords,
  insertPages,
  queryCountriesWithComparison,
  queryDevicesWithComparison,
  queryKeyword,
  queryKeywordsWithComparison,
  queryPage,
  queryPages,
  queryPagesWithComparison,
  syncSites,
  toGscMetrics,
} from '@gscdump/db'
import {
  createQueryBody,
  fetchCountriesWithComparison,
  fetchDates,
  fetchDatesWithComparison,
  fetchDevicesWithComparison,
  fetchKeyword,
  fetchKeywordsWithComparison,
  fetchPage,
  fetchPagesWithComparison,
  fetchSearchAppearanceWithComparison,
  googleSearchConsole,
  queryRecursive,
} from 'gscdump'

function toDateRange(period: { start: Date | string, end: Date | string }): DateRange {
  return {
    startDate: typeof period.start === 'string' ? period.start : period.start.toISOString().split('T')[0],
    endDate: typeof period.end === 'string' ? period.end : period.end.toISOString().split('T')[0],
  }
}

function getDate(period: { start: Date | string }): string {
  return typeof period.start === 'string' ? period.start : period.start.toISOString().split('T')[0]
}

interface SyncBuffer {
  pages: SitePathDateAnalyticsInsert[]
  keywords: SiteKeywordDateAnalyticsInsert[]
  countries: SiteDateCountryAnalyticsInsert[]
  devices: SiteDateDeviceAnalyticsInsert[]
}

function createBuffer(): SyncBuffer {
  return { pages: [], keywords: [], countries: [], devices: [] }
}

/**
 * Creates a hybrid provider that uses DB as cache, fetching from API when data is missing.
 * Data is buffered in memory until sync() is called.
 *
 * @example
 * const provider = createHybridProvider(auth, db)
 * await provider.getPagesWithComparison(site, range) // fetches, buffers
 * await provider.getKeywordsWithComparison(site, range) // fetches, buffers
 * await provider.sync() // single transaction write
 */
export function createHybridProvider(auth: Auth, db: GscDb): DataProvider {
  const client = googleSearchConsole(auth)
  const siteIdCache = new Map<string, number>()
  let buffer = createBuffer()

  const ensureSiteId = async (siteUrl: string): Promise<number> => {
    const cached = siteIdCache.get(siteUrl)
    if (cached)
      return cached

    let site = await getSiteByProperty(db, siteUrl)
    if (!site?.siteId) {
      await syncSites(db, client)
      site = await getSiteByProperty(db, siteUrl)
    }

    if (!site?.siteId)
      throw new Error(`Site not found: ${siteUrl}`)

    siteIdCache.set(siteUrl, site.siteId)
    return site.siteId
  }

  // Check if data exists in DB for a range
  const hasData = async (siteId: number, range: DateRange): Promise<boolean> => {
    return hasDataForRange(db, siteId, range)
  }

  return {
    source: 'hybrid',

    getDatesWithComparison: async (siteUrl, range) => {
      // Dates aren't synced to DB, always fetch from API
      return fetchDatesWithComparison(client, siteUrl, range)
    },

    getPages: async (siteUrl, range) => {
      const siteId = await ensureSiteId(siteUrl)
      const dateRange = toDateRange(range.period)

      // Check DB first
      if (await hasData(siteId, dateRange)) {
        return queryPages(db, siteId, dateRange)
      }

      // Fetch from API, buffer, return result
      const result = await fetchPagesWithComparison(client, siteUrl, range)
      const date = getDate(range.period)

      buffer.pages.push(...result.current.map(row => ({
        siteId,
        date,
        path: row.page.replace(/^https?:\/\/[^/]+/, ''),
        ...toGscMetrics(row),
      })))

      // Return in Page format (page property matches gscdump's Page interface)
      return result.current.map(p => ({
        page: p.page,
        clicks: p.clicks ?? 0,
        impressions: p.impressions ?? 0,
        ctr: p.ctr ?? 0,
        position: p.position ?? 0,
      }))
    },

    getPagesWithComparison: async (siteUrl, range) => {
      const siteId = await ensureSiteId(siteUrl)
      const currentRange = toDateRange(range.period)
      const prevRange = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined

      // Check if both periods exist in DB
      const hasCurrent = await hasData(siteId, currentRange)
      const hasPrev = !prevRange || await hasData(siteId, prevRange)

      if (hasCurrent && hasPrev) {
        return queryPagesWithComparison(db, siteId, currentRange, prevRange)
      }

      // Fetch from API
      const result = await fetchPagesWithComparison(client, siteUrl, range)

      // Buffer current period
      if (!hasCurrent) {
        const date = getDate(range.period)
        buffer.pages.push(...result.current.map(row => ({
          siteId,
          date,
          path: row.page.replace(/^https?:\/\/[^/]+/, ''),
          ...toGscMetrics(row),
        })))
      }

      // Buffer previous period
      if (range.prevPeriod && result.previous && !hasPrev) {
        const prevDate = getDate(range.prevPeriod)
        buffer.pages.push(...result.previous.map(row => ({
          siteId,
          date: prevDate,
          path: row.page.replace(/^https?:\/\/[^/]+/, ''),
          ...toGscMetrics(row),
        })))
      }

      return result
    },

    getKeywordsWithComparison: async (siteUrl, range) => {
      const siteId = await ensureSiteId(siteUrl)
      const currentRange = toDateRange(range.period)
      const prevRange = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined

      const hasCurrent = await hasData(siteId, currentRange)
      const hasPrev = !prevRange || await hasData(siteId, prevRange)

      if (hasCurrent && hasPrev) {
        return queryKeywordsWithComparison(db, siteId, currentRange, prevRange)
      }

      const result = await fetchKeywordsWithComparison(client, siteUrl, range)

      if (!hasCurrent) {
        const date = getDate(range.period)
        buffer.keywords.push(...result.current.map(row => ({
          siteId,
          date,
          keyword: row.keyword,
          ...toGscMetrics(row),
        })))
      }

      if (range.prevPeriod && result.previous && !hasPrev) {
        const prevDate = getDate(range.prevPeriod)
        buffer.keywords.push(...result.previous.map(row => ({
          siteId,
          date: prevDate,
          keyword: row.keyword,
          ...toGscMetrics(row),
        })))
      }

      return result
    },

    getCountriesWithComparison: async (siteUrl, range) => {
      const siteId = await ensureSiteId(siteUrl)
      const currentRange = toDateRange(range.period)
      const prevRange = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined

      const hasCurrent = await hasData(siteId, currentRange)
      const hasPrev = !prevRange || await hasData(siteId, prevRange)

      if (hasCurrent && hasPrev) {
        return queryCountriesWithComparison(db, siteId, currentRange, prevRange)
      }

      const result = await fetchCountriesWithComparison(client, siteUrl, range)

      if (!hasCurrent) {
        const date = getDate(range.period)
        buffer.countries.push(...result.current.map(row => ({
          siteId,
          date,
          country: row.countryCodeGsc,
          ...toGscMetrics(row),
        })))
      }

      if (range.prevPeriod && result.previous && !hasPrev) {
        const prevDate = getDate(range.prevPeriod)
        buffer.countries.push(...result.previous.map(row => ({
          siteId,
          date: prevDate,
          country: row.countryCodeGsc,
          ...toGscMetrics(row),
        })))
      }

      return result
    },

    getDevicesWithComparison: async (siteUrl, range) => {
      const siteId = await ensureSiteId(siteUrl)
      const currentRange = toDateRange(range.period)
      const prevRange = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined

      const hasCurrent = await hasData(siteId, currentRange)
      const hasPrev = !prevRange || await hasData(siteId, prevRange)

      if (hasCurrent && hasPrev) {
        return queryDevicesWithComparison(db, siteId, currentRange, prevRange)
      }

      const result = await fetchDevicesWithComparison(client, siteUrl, range)

      if (!hasCurrent) {
        const date = getDate(range.period)
        buffer.devices.push(...result.current.map(row => ({
          siteId,
          date,
          device: row.device,
          ...toGscMetrics(row),
        })))
      }

      if (range.prevPeriod && result.previous && !hasPrev) {
        const prevDate = getDate(range.prevPeriod)
        buffer.devices.push(...result.previous.map(row => ({
          siteId,
          date: prevDate,
          device: row.device,
          ...toGscMetrics(row),
        })))
      }

      return result
    },

    getPage: async (siteUrl, range, path) => {
      const siteId = await ensureSiteId(siteUrl)
      const dateRange = toDateRange(range.period)

      if (await hasData(siteId, dateRange)) {
        return queryPage(db, siteId, dateRange, path)
      }

      // Fetch directly from API (no buffering for drill-down queries)
      return fetchPage(client, siteUrl, path, { period: range.period })
    },

    getKeyword: async (siteUrl, range, keyword) => {
      const siteId = await ensureSiteId(siteUrl)
      const dateRange = toDateRange(range.period)

      if (await hasData(siteId, dateRange)) {
        return queryKeyword(db, siteId, dateRange, keyword)
      }

      // Fetch directly from API (no buffering for drill-down queries)
      return fetchKeyword(client, siteUrl, keyword, { period: range.period })
    },

    getSearchAppearanceWithComparison: (siteUrl, range) =>
      fetchSearchAppearanceWithComparison(client, siteUrl, range),

    getQueryPageRows: async (siteUrl, range) => {
      const query = createQueryBody({ period: range.period })
      const { rows } = await queryRecursive(client, siteUrl, {
        ...query,
        dimensions: ['query', 'page'],
      })
      return rows.map(row => ({
        query: row.keys?.[0] || '',
        page: row.keys?.[1] || '',
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: row.ctr || 0,
        position: row.position || 0,
      }))
    },

    getDateRows: async (siteUrl, range) => {
      const dates = await fetchDates(client, siteUrl, { period: range.period })
      return dates.map(d => ({
        date: d.date,
        clicks: d.clicks || 0,
        impressions: d.impressions || 0,
        ctr: d.ctr || 0,
        position: d.position || 0,
      }))
    },

    // Sync methods
    sync: async () => {
      await Promise.all([
        buffer.pages.length > 0 ? insertPages(db, buffer.pages) : Promise.resolve(),
        buffer.keywords.length > 0 ? insertKeywords(db, buffer.keywords) : Promise.resolve(),
        buffer.countries.length > 0 ? insertCountries(db, buffer.countries) : Promise.resolve(),
        buffer.devices.length > 0 ? insertDevices(db, buffer.devices) : Promise.resolve(),
      ])
      buffer = createBuffer()
    },

    discard: () => {
      buffer = createBuffer()
    },

    pending: () => buffer.pages.length + buffer.keywords.length + buffer.countries.length + buffer.devices.length,
  }
}
