import type { DataRow } from '../../core/types'
import type { GoogleSearchConsoleClient } from '../../core/client'
import countries from '../../utils/countries'
import { createQueryBody } from './query'
import type { ComparisonResult, CountryData, DeviceData, QueryOptions, SearchAppearanceData } from './types'

/**
 * Fetches device breakdown (desktop, mobile, tablet) with period comparison.
 */
export async function fetchDevicesWithComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<ComparisonResult<DeviceData>> {
  const [current, previous] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['device'],
    }).then((res) => {
      return (res.rows || []).map((row) => {
        return {
          ...row,
          dimension: 'device' as const,
          device: row.keys?.[0] || 'unknown',
          keys: null,
          clicks: Number(row.clicks) || 0,
          impressions: Number(row.impressions) || 0,
          ctr: Number(row.ctr) || 0,
          position: Number(row.position) || 0,
        }
      })
    }),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
          dimensions: ['device'],
        }).then((res) => {
          return (res.rows || []).map((row) => {
            return {
              ...row,
              dimension: 'device' as const,
              device: row.keys?.[0] || 'unknown',
              keys: null,
              clicks: Number(row.clicks) || 0,
              impressions: Number(row.impressions) || 0,
              ctr: Number(row.ctr) || 0,
              position: Number(row.position) || 0,
            }
          })
        })
      : Promise.resolve([]),
  ])

  return {
    current,
    previous,
    metadata: { currentCount: current.length, previousCount: previous.length },
  }
}

/**
 * Fetches device breakdown (desktop, mobile, tablet).
 */
export async function fetchDevices(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<DeviceData[]> {
  return client.searchAnalytics.query(siteUrl, {
    ...createQueryBody(options),
    dimensions: ['device'],
  }).then((res) => {
    return (res.rows || []).map((row) => {
      return {
        ...row,
        dimension: 'device' as const,
        device: row.keys?.[0] || 'unknown',
        keys: null,
        clicks: Number(row.clicks) || 0,
        impressions: Number(row.impressions) || 0,
        ctr: Number(row.ctr) || 0,
        position: Number(row.position) || 0,
      }
    })
  })
}

function fixCountryRows(res: { rows?: DataRow[] }): CountryData[] {
  return (res.rows || []).map((row) => {
    const alpha3Code = row.keys?.[0] || ''
    const country = countries.find(c => c['alpha-3'].toLowerCase() === alpha3Code)
    return {
      ...row,
      dimension: 'country' as const,
      countryCodeGsc: alpha3Code,
      country: country?.name || alpha3Code,
      countryCode: country?.['alpha-2'] || alpha3Code,
      keys: null,
    }
  })
}

/**
 * Fetches top countries by traffic with period comparison and keyword counts per country.
 */
export async function fetchCountriesWithComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<ComparisonResult<CountryData>> {
  const [current, previous] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['country'],
      rowLimit: 5,
    }).then(fixCountryRows),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
          dimensions: ['country'],
          rowLimit: 5,
        }).then(fixCountryRows)
      : Promise.resolve([]),
  ])

  const keywordCounts = await Promise.all(current.map((row) => {
    return client.searchAnalytics.query(siteUrl, {
      ...createQueryBody({
        ...options,
        filters: [{ dimension: 'country', operator: 'equals', expression: row.countryCodeGsc }],
      }),
      dimensions: ['query'],
    }).then(res => ({
      countryCodeGsc: row.countryCodeGsc,
      keywords: res.rows?.length || 0,
    })).catch(() => ({
      countryCodeGsc: row.countryCodeGsc,
      keywords: 0,
    }))
  }))

  for (const row of current) {
    const keywordCount = keywordCounts.find(k => k.countryCodeGsc === row.countryCodeGsc)
    if (keywordCount)
      row.keywords = keywordCount.keywords
  }

  return {
    current,
    previous,
    metadata: {
      currentCount: current.length,
      previousCount: previous.length,
      totalKeywords: keywordCounts.reduce((sum, k) => sum + k.keywords, 0),
    },
  }
}

/**
 * Fetches top countries by traffic.
 */
export async function fetchCountries(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<CountryData[]> {
  return client.searchAnalytics.query(siteUrl, {
    ...createQueryBody(options),
    dimensions: ['country'],
    rowLimit: 5,
  }).then(fixCountryRows)
}

/**
 * Fetches search appearance breakdown (AMP, rich results, etc.) with period comparison.
 */
export async function fetchSearchAppearanceWithComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<ComparisonResult<SearchAppearanceData>> {
  const [current, previous] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody(options),
      dimensions: ['searchAppearance'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      dimension: 'searchAppearance' as const,
      searchAppearance: row.keys?.[0] || 'unknown',
      keys: null,
      clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      ctr: Number(row.ctr) || 0,
      position: Number(row.position) || 0,
    }))),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
          dimensions: ['searchAppearance'],
        }).then(res => (res.rows || []).map(row => ({
          ...row,
          dimension: 'searchAppearance' as const,
          searchAppearance: row.keys?.[0] || 'unknown',
          keys: null,
          clicks: Number(row.clicks) || 0,
          impressions: Number(row.impressions) || 0,
          ctr: Number(row.ctr) || 0,
          position: Number(row.position) || 0,
        })))
      : Promise.resolve([]),
  ])

  return {
    current,
    previous,
    metadata: { currentCount: current.length, previousCount: previous.length },
  }
}

/**
 * Fetches search appearance breakdown (AMP, rich results, etc.).
 */
export async function fetchSearchAppearance(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: QueryOptions = {},
): Promise<SearchAppearanceData[]> {
  return client.searchAnalytics.query(siteUrl, {
    ...createQueryBody(options),
    dimensions: ['searchAppearance'],
  }).then(res => (res.rows || []).map(row => ({
    ...row,
    dimension: 'searchAppearance' as const,
    searchAppearance: row.keys?.[0] || 'unknown',
    keys: null,
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
    ctr: Number(row.ctr) || 0,
    position: Number(row.position) || 0,
  })))
}