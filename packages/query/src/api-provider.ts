import type { Auth } from 'gscdump'
import type { DataProvider } from './types'
import {
  createQueryBody,
  fetchCountriesWithComparison,
  fetchDates,
  fetchDatesWithComparison,
  fetchDevicesWithComparison,
  fetchKeyword,
  fetchKeywordsWithComparison,
  fetchPage,
  fetchPages,
  fetchPagesWithComparison,
  fetchSearchAppearanceWithComparison,
  googleSearchConsole,
  queryRecursive,
} from 'gscdump'

export function createApiProvider(auth: Auth): DataProvider {
  const client = googleSearchConsole(auth)

  return {
    source: 'api',

    getDatesWithComparison: (siteUrl, range) =>
      fetchDatesWithComparison(client, siteUrl, range),

    getPages: (siteUrl, range) =>
      fetchPages(client, siteUrl, range),

    getPagesWithComparison: (siteUrl, range) =>
      fetchPagesWithComparison(client, siteUrl, range),

    getKeywordsWithComparison: (siteUrl, range) =>
      fetchKeywordsWithComparison(client, siteUrl, range),

    getCountriesWithComparison: (siteUrl, range) =>
      fetchCountriesWithComparison(client, siteUrl, range),

    getDevicesWithComparison: (siteUrl, range) =>
      fetchDevicesWithComparison(client, siteUrl, range),

    getPage: (siteUrl, range, path) =>
      fetchPage(client, siteUrl, path, range),

    getKeyword: (siteUrl, range, keyword) =>
      fetchKeyword(client, siteUrl, keyword, range),

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
  }
}