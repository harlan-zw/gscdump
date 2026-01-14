import type { DateRange, GscDb } from '@gscdump/db'
import type { DataProvider } from './types'
import {
  queryCountriesWithComparison,
  queryDatesWithComparison,
  queryDevicesWithComparison,
  queryKeyword,
  queryKeywordsWithComparison,
  queryPage,
  queryPages,
  queryPagesWithComparison,
} from '@gscdump/db'

function toDateRange(period: { start: Date | string, end: Date | string }): DateRange {
  return {
    startDate: typeof period.start === 'string' ? period.start : period.start.toISOString().split('T')[0],
    endDate: typeof period.end === 'string' ? period.end : period.end.toISOString().split('T')[0],
  }
}

export function createDbProvider(db: GscDb, siteIdMap: Map<string, number>): DataProvider {
  const getSiteId = (siteUrl: string): number => {
    const siteId = siteIdMap.get(siteUrl)
    if (!siteId)
      throw new Error(`Site not found in database: ${siteUrl}`)
    return siteId
  }

  return {
    source: 'db',

    getDatesWithComparison: async (siteUrl, range) => {
      const siteId = getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryDatesWithComparison(db, siteId, current, previous)
    },

    getPages: async (siteUrl, range) => {
      const siteId = getSiteId(siteUrl)
      const rows = await queryPages(db, siteId, toDateRange(range.period))
      return rows
    },

    getPagesWithComparison: async (siteUrl, range) => {
      const siteId = getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryPagesWithComparison(db, siteId, current, previous)
    },

    getKeywordsWithComparison: async (siteUrl, range) => {
      const siteId = getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryKeywordsWithComparison(db, siteId, current, previous)
    },

    getCountriesWithComparison: async (siteUrl, range) => {
      const siteId = getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryCountriesWithComparison(db, siteId, current, previous)
    },

    getDevicesWithComparison: async (siteUrl, range) => {
      const siteId = getSiteId(siteUrl)
      const current = toDateRange(range.period)
      const previous = range.prevPeriod ? toDateRange(range.prevPeriod) : undefined
      return queryDevicesWithComparison(db, siteId, current, previous)
    },

    getPage: async (siteUrl, range, path) => {
      const siteId = getSiteId(siteUrl)
      return queryPage(db, siteId, toDateRange(range.period), path)
    },

    getKeyword: async (siteUrl, range, keyword) => {
      const siteId = getSiteId(siteUrl)
      return queryKeyword(db, siteId, toDateRange(range.period), keyword)
    },

    // Not available from DB
    getSearchAppearanceWithComparison: undefined,
  }
}
