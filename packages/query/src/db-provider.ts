import type { DateRange, GscDb } from '@gscdump/db'
import type { DataProvider } from './types'
import {
  getSiteByProperty,
  queryCountriesWithComparison,
  queryDateRows,
  queryDatesWithComparison,
  queryDevicesWithComparison,
  queryKeyword,
  queryKeywordsWithComparison,
  queryPage,
  queryPages,
  queryPagesWithComparison,
  queryQueryPageRows,
} from '@gscdump/db'

function toDateRange(period: { start: Date | string, end: Date | string }): DateRange {
  return {
    startDate: typeof period.start === 'string' ? period.start : period.start.toISOString().split('T')[0],
    endDate: typeof period.end === 'string' ? period.end : period.end.toISOString().split('T')[0],
  }
}

export function createDbProvider(db: GscDb): DataProvider {
  // Cache siteId lookups
  const siteIdCache = new Map<string, number>()

  const getSiteId = async (siteUrl: string): Promise<number> => {
    const cached = siteIdCache.get(siteUrl)
    if (cached)
      return cached

    const site = await getSiteByProperty(db, siteUrl)
    if (!site?.siteId)
      throw new Error(`Site not found in database: ${siteUrl}. Run 'gscdump sync' first.`)

    siteIdCache.set(siteUrl, site.siteId)
    return site.siteId
  }

  return {
    source: 'db',

    getDatesWithComparison: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryDatesWithComparison(db, siteId, current, previous)
    },

    getPages: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      return queryPages(db, siteId, toDateRange(range.period))
    },

    getPagesWithComparison: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryPagesWithComparison(db, siteId, current, previous)
    },

    getKeywordsWithComparison: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryKeywordsWithComparison(db, siteId, current, previous)
    },

    getCountriesWithComparison: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryCountriesWithComparison(db, siteId, current, previous)
    },

    getDevicesWithComparison: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryDevicesWithComparison(db, siteId, current, previous)
    },

    getPage: async (siteUrl, range, path) => {
      const siteId = await getSiteId(siteUrl)
      return queryPage(db, siteId, toDateRange(range.period), path)
    },

    getKeyword: async (siteUrl, range, keyword) => {
      const siteId = await getSiteId(siteUrl)
      return queryKeyword(db, siteId, toDateRange(range.period), keyword)
    },

    // Not available from DB
    getSearchAppearanceWithComparison: undefined,

    getQueryPageRows: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      return queryQueryPageRows(db, siteId, toDateRange(range.period))
    },

    getDateRows: async (siteUrl, range) => {
      const siteId = await getSiteId(siteUrl)
      return queryDateRows(db, siteId, toDateRange(range.period))
    },
  }
}
