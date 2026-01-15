import type { Auth } from 'gscdump'
import type { DataProvider } from './types'
import {
  fetchCountriesWithComparison,
  fetchDatesWithComparison,
  fetchDevicesWithComparison,
  fetchKeyword,
  fetchKeywordsWithComparison,
  fetchPage,
  fetchPages,
  fetchPagesWithComparison,
  fetchSearchAppearanceWithComparison,
  googleSearchConsole,
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
  }
}