import type { GscAuth, Site } from 'gscdump'
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
} from 'gscdump'

function toSite(siteUrl: string): Site {
  return { siteUrl, permissionLevel: 'owner' as const }
}

export function createApiProvider(auth: GscAuth): DataProvider {
  return {
    source: 'api',

    getDatesWithComparison: (siteUrl, range) =>
      fetchDatesWithComparison(auth, siteUrl, range),

    getPages: (siteUrl, range) =>
      fetchPages(auth, toSite(siteUrl), range),

    getPagesWithComparison: (siteUrl, range) =>
      fetchPagesWithComparison(auth, toSite(siteUrl), range),

    getKeywordsWithComparison: (siteUrl, range) =>
      fetchKeywordsWithComparison(auth, toSite(siteUrl), range),

    getCountriesWithComparison: (siteUrl, range) =>
      fetchCountriesWithComparison(auth, toSite(siteUrl), range),

    getDevicesWithComparison: (siteUrl, range) =>
      fetchDevicesWithComparison(auth, toSite(siteUrl), range),

    getPage: (siteUrl, range, path) =>
      fetchPage(auth, toSite(siteUrl), range, path),

    getKeyword: (siteUrl, range, keyword) =>
      fetchKeyword(auth, toSite(siteUrl), range, keyword),

    getSearchAppearanceWithComparison: (siteUrl, range) =>
      fetchSearchAppearanceWithComparison(auth, toSite(siteUrl), range),
  }
}
