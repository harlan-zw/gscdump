import type { searchconsole_v1 } from '@googleapis/searchconsole/v1'
import type { GscAuth } from './client'
import type { Period, ResolvedAnalyticsRange } from './types'
import { withBase, withHttps, withoutTrailingSlash } from 'ufo'
import { gscClient } from './client'
import countries from './countries'
import { dayjs } from './dayjs'
import { formatDateGsc, percentDifference } from './utils'

export type DataType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'
export type DataState = 'final' | 'all'
export type AggregationType = 'byPage' | 'byProperty'

export interface QueryOptions {
  period?: Period
  domain?: string
  filters?: searchconsole_v1.Schema$ApiDimensionFilter[]
  /** Data type: web, image, video, news, discover, googleNews. Default: web */
  type?: DataType
  /** Data state: final (settled data) or all (includes fresh/unfinalized). Default: all */
  dataState?: DataState
  /**
   * Aggregation type: byPage (per-URL metrics) or byProperty (domain-level rollup).
   * Use byProperty for sc-domain: properties to get true totals.
   * byPage can undercount when same query hits multiple pages.
   * Default: byPage
   */
  aggregationType?: AggregationType
}

export interface ComparisonResult<T> {
  current: T[]
  previous: T[]
  metadata?: {
    currentCount: number
    previousCount: number
    [key: string]: unknown
  }
}

export interface DeviceData extends Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> {
  dimension: 'device'
  device: string
  keys: null
}

export interface CountryData extends Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> {
  dimension: 'country'
  countryCodeGsc: string
  country: string
  countryCode: string
  keywords?: number
  keys: null
}

export interface AnalyticsData extends Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> {
  keywords: searchconsole_v1.Schema$ApiDataRow[]
}

export interface PageData extends Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> {
  dimension: 'page'
  page: string
  keyword?: string
  keywordPosition?: number
  prevClicks?: number
  clicksPercent?: number
  prevImpressions?: number
  impressionsPercent?: number
  lost?: boolean
  keys: null
}

export interface KeywordData extends Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> {
  dimension: 'query'
  keyword: string
  page?: string | null
  positionPercent?: number
  prevPosition?: number
  ctrPercent?: number
  prevCtr?: number
  lost?: boolean
  prevClicks?: number
  prevImpressions?: number
  keys: null
}

/**
 * Discriminated union of all query result row types.
 * Use the `dimension` field to narrow to specific types.
 */
export type QueryResultRow
  = | DateData
    | DeviceData
    | CountryData
    | PageData
    | KeywordData
    | SearchAppearanceData

/**
 * Recursively queries GSC search analytics, automatically handling pagination for large datasets.
 */
export async function queryRecursive(
  auth: GscAuth,
  siteUrl: string,
  query: searchconsole_v1.Schema$SearchAnalyticsQueryRequest,
  page: number = 1,
  rows: searchconsole_v1.Schema$ApiDataRow[] = [],
): Promise<{ data: { rows: searchconsole_v1.Schema$ApiDataRow[] }, pages: number }> {
  const rowLimit = query.rowLimit || 25_000
  const res = await gscClient.searchAnalytics.query(auth, siteUrl, {
    ...query,
    startRow: (page - 1) * rowLimit,
  })
  const _rows = res.rows || []
  const rowsLength = _rows.length || 0
  rows.push(..._rows)
  let finalPage = page
  if (rowsLength === rowLimit) {
    const recursiveResult = await queryRecursive(auth, siteUrl, query, page + 1, rows)
    finalPage = recursiveResult.pages
  }
  return { data: { rows }, pages: finalPage }
}

export interface DateData extends Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> {
  dimension: 'date'
  date: string
}

export interface DatesComparisonResult {
  current: DateData[]
  previous: DateData[]
  metadata: {
    currentCount: number
    previousCount: number
    totals: {
      current: { clicks: number, impressions: number, ctr: number, position: number }
      previous: { clicks: number, impressions: number, ctr: number, position: number }
      clicksPercent: number
      impressionsPercent: number
      ctrPercent: number
      positionPercent: number
    }
  }
}

function computeTotals(rows: DateData[]) {
  if (!rows.length)
    return { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  return {
    clicks: rows.reduce((sum, r) => sum + (r.clicks || 0), 0),
    impressions: rows.reduce((sum, r) => sum + (r.impressions || 0), 0),
    ctr: rows.reduce((sum, r) => sum + (r.ctr || 0), 0) / rows.length,
    position: rows.reduce((sum, r) => sum + (r.position || 0), 0) / rows.length,
  }
}

/**
 * Fetches daily search analytics data with period-over-period comparison.
 */
export async function fetchDatesWithComparison(auth: GscAuth, siteUrl: string, range: ResolvedAnalyticsRange, options?: QueryOptions): Promise<DatesComparisonResult> {
  const [current, previous] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
      dimensions: ['date'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      dimension: 'date' as const,
      date: row.keys?.[0] || '',
      keys: undefined,
    }))),
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
          dimensions: ['date'],
        }).then(res => (res.rows || []).map(row => ({
          ...row,
          dimension: 'date' as const,
          date: row.keys?.[0] || '',
          keys: undefined,
        })))
      : Promise.resolve([]),
  ])

  const currentTotals = computeTotals(current)
  const previousTotals = computeTotals(previous)

  return {
    current,
    previous,
    metadata: {
      currentCount: current.length,
      previousCount: previous.length,
      totals: {
        current: currentTotals,
        previous: previousTotals,
        clicksPercent: percentDifference(currentTotals.clicks, previousTotals.clicks),
        impressionsPercent: percentDifference(currentTotals.impressions, previousTotals.impressions),
        ctrPercent: percentDifference(currentTotals.ctr, previousTotals.ctr),
        positionPercent: percentDifference(currentTotals.position, previousTotals.position),
      },
    },
  }
}

/**
 * Fetches daily search analytics data for a site.
 */
export async function fetchDates(auth: GscAuth, siteUrl: string, range: ResolvedAnalyticsRange, options?: QueryOptions): Promise<{ startDate?: string, endDate?: string, rows: (Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> & { date: string })[] }> {
  const dates = await gscClient.searchAnalytics.query(auth, siteUrl, {
    ...createQueryBody(options),
    dimensions: ['date'],
  }).then((res) => {
    return (res.rows || []).map((row) => {
      return {
        ...row,
        date: row.keys?.[0] || '',
        keys: undefined,
      }
    })
  })
  if (!dates.length) {
    return { startDate: undefined, endDate: undefined, rows: [] }
  }
  return {
    startDate: dates[0].date,
    endDate: dates[dates.length - 1].date,
    rows: dates,
  }
}

/**
 * Fetches device breakdown (desktop, mobile, tablet) with period comparison.
 */
export async function fetchDevicesWithComparison(
  auth: GscAuth,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: QueryOptions,
): Promise<ComparisonResult<DeviceData>> {
  const [current, previous] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
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
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
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
 * Fetches top countries by traffic with period comparison and keyword counts per country.
 */
export async function fetchCountriesWithComparison(
  auth: GscAuth,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: QueryOptions,
): Promise<ComparisonResult<CountryData>> {
  function fixCountryRows(res: { rows?: searchconsole_v1.Schema$ApiDataRow[] }): CountryData[] {
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

  const [current, previous] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
      dimensions: ['country'],
      rowLimit: 5,
    }).then(fixCountryRows),
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
          dimensions: ['country'],
          rowLimit: 5,
        }).then(fixCountryRows)
      : Promise.resolve([]),
  ])

  const keywordCounts = await Promise.all(current.map((row) => {
    return gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({
        period: range.period,
        filters: [{ dimension: 'country', operator: 'equals', expression: row.countryCodeGsc }],
        ...options,
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
 * Fetches overall site analytics summary with period comparison and keyword data.
 */
export async function fetchAnalyticsWithComparison(
  auth: GscAuth,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: QueryOptions,
): Promise<ComparisonResult<AnalyticsData>> {
  const [currentSummary, previousSummary, currentKeywords, previousKeywords] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
    }).then(res => (res.rows || [])[0] || {}),
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
        }).then(res => (res.rows || [])[0] || {})
      : Promise.resolve({}),
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
      dimensions: ['date', 'query'],
    }).then(res => res.rows || []),
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
          dimensions: ['date', 'query'],
        }).then(res => res.rows || [])
      : Promise.resolve([]),
  ])

  return {
    current: [{ ...currentSummary, keywords: currentKeywords }],
    previous: [{ ...previousSummary, keywords: previousKeywords }],
    metadata: {
      currentCount: 1,
      previousCount: range.prevPeriod ? 1 : 0,
      currentKeywordCount: currentKeywords.length,
      previousKeywordCount: previousKeywords.length,
    },
  }
}

export type Page = (Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> & { page: string })

/**
 * Fetches all pages with their performance data using recursive pagination.
 */
export async function fetchPages(auth: GscAuth, siteUrl: string, range: ResolvedAnalyticsRange, options?: QueryOptions): Promise<Page[]> {
  const period = await queryRecursive(auth, siteUrl, {
    ...createQueryBody({ period: range.period, ...options }),
    dimensions: ['page'],
  }).then(d => d.data.rows)
  return period.map(row => ({
    ...row,
    page: row.keys?.[0] || '',
  }))
}

/**
 * Fetches page performance data with period comparison, including top keyword per page.
 */
export async function fetchPagesWithComparison(
  auth: GscAuth,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: QueryOptions,
): Promise<ComparisonResult<PageData>> {
  const [currentPages, previousPages, keywords] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
      dimensions: ['page'],
    }).then(res => res.rows || []),
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
          dimensions: ['page'],
        }).then(res => res.rows || [])
      : Promise.resolve([]),
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
      dimensions: ['query', 'page'],
    }).then(res => res.rows || []),
  ])

  const current = currentPages.map((row) => {
    const prevRow = previousPages.find(r => r.keys?.[0] === row.keys?.[0])
    const keyword = keywords.find(r => r.keys?.[1] === row.keys?.[0])
    const clicks = row.clicks ?? 0
    const impressions = row.impressions ?? 0
    const prevClicks = prevRow?.clicks ?? 0
    const prevImpressions = prevRow?.impressions ?? 0
    return {
      ...row,
      dimension: 'page' as const,
      page: row.keys?.[0] || '',
      keyword: keyword?.keys?.[0] || undefined,
      keywordPosition: keyword?.position ?? 0,
      clicks,
      prevClicks,
      clicksPercent: percentDifference(clicks, prevClicks),
      impressions,
      impressionsPercent: percentDifference(impressions, prevImpressions),
      prevImpressions,
      keys: null,
    }
  })

  const previous = previousPages.map((prevRow) => {
    const pageKey = prevRow.keys?.[0] || ''
    const currentRow = currentPages.find(r => r.keys?.[0] === pageKey)
    if (!currentRow) {
      return {
        ...prevRow,
        dimension: 'page' as const,
        page: pageKey,
        lost: true,
        clicks: 0,
        impressions: 0,
        prevClicks: prevRow.clicks ?? 0,
        prevImpressions: prevRow.impressions ?? 0,
        keys: null,
      }
    }
    return { ...prevRow, dimension: 'page' as const, page: pageKey, keys: null }
  })

  return {
    current,
    previous,
    metadata: {
      currentCount: current.length,
      previousCount: previous.length,
      keywordMatches: keywords.length,
    },
  }
}

/**
 * Fetches keyword/query performance data with period comparison and associated pages.
 */
export async function fetchKeywordsWithComparison(
  auth: GscAuth,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: QueryOptions,
): Promise<ComparisonResult<KeywordData>> {
  const [currentKeywords, previousKeywords, pages] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
      dimensions: ['query'],
    }).then(res => res.rows || []),
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
          dimensions: ['query'],
        }).then(res => res.rows || [])
      : Promise.resolve([]),
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
      dimensions: ['page', 'query'],
    }).then(res => res.rows || []),
  ])

  const current = currentKeywords.map((row) => {
    const prevRow = previousKeywords.find(r => r.keys?.[0] === row.keys?.[0])
    const pageMatch = pages.find(r => r.keys?.[1] === row.keys?.[0])
    const position = row.position ?? 0
    const ctr = row.ctr ?? 0
    const prevPosition = prevRow?.position ?? 0
    const prevCtr = prevRow?.ctr ?? 0
    return {
      ...row,
      dimension: 'query' as const,
      keyword: row.keys?.[0] || '',
      page: pageMatch?.keys?.[0] ? normalizePagePath(pageMatch.keys[0], siteUrl) : null,
      position,
      positionPercent: percentDifference(position, prevPosition),
      prevPosition,
      ctr,
      ctrPercent: percentDifference(ctr, prevCtr),
      prevCtr,
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      keys: null,
    }
  })

  const previous = previousKeywords.map((prevRow) => {
    const keywordKey = prevRow.keys?.[0] || ''
    const currentRow = currentKeywords.find(r => r.keys?.[0] === keywordKey)
    const pageMatch = pages.find(r => r.keys?.[1] === keywordKey)
    if (!currentRow) {
      return {
        ...prevRow,
        dimension: 'query' as const,
        keyword: keywordKey,
        page: pageMatch?.keys?.[0] ? normalizePagePath(pageMatch.keys[0], siteUrl) : null,
        lost: true,
        clicks: 0,
        position: 0,
        ctr: 0,
        prevCtr: prevRow.ctr ?? 0,
        prevPosition: prevRow.position ?? 0,
        prevClicks: prevRow.clicks ?? 0,
        prevImpressions: prevRow.impressions ?? 0,
        keys: null,
      }
    }
    return {
      ...prevRow,
      dimension: 'query' as const,
      keyword: keywordKey,
      page: pageMatch?.keys?.[0] ? normalizePagePath(pageMatch.keys[0], siteUrl) : null,
      keys: null,
    }
  })

  return {
    current,
    previous,
    metadata: {
      currentCount: current.length,
      previousCount: previous.length,
      pageMatches: pages.length,
    },
  }
}

export interface FetchKeywordOptions extends QueryOptions {
  /** Maximum pages to return. Default: 5 */
  rowLimit?: number
}

/**
 * Fetches detailed data for a specific keyword including daily trends and top pages.
 */
export async function fetchKeyword(auth: GscAuth, siteUrl: string, range: ResolvedAnalyticsRange, keyword: string, options: FetchKeywordOptions = {}): Promise<{ dates: searchconsole_v1.Schema$ApiDataRow[], pages: searchconsole_v1.Schema$ApiDataRow[] }> {
  const { rowLimit = 5, ...queryOptions } = options
  const [dates, pages] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({
        period: range.period,
        filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
        ...queryOptions,
      }),
      dimensions: ['date'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      date: row.keys?.[0] ?? '',
      keys: undefined,
    }))),
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({
        period: range.period,
        filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
        ...queryOptions,
      }),
      rowLimit,
      dimensions: ['page'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      page: normalizePagePath(row.keys?.[0] || '', extractDomain(siteUrl)),
      keys: undefined,
    }))),
  ])
  return { dates, pages }
}

export interface FetchPageOptions extends QueryOptions {
  /** Maximum keywords to return. Default: 5 */
  rowLimit?: number
}

/**
 * Fetches detailed data for a specific page including daily trends and top keywords.
 */
export async function fetchPage(auth: GscAuth, siteUrl: string, range: ResolvedAnalyticsRange, url: string, options: FetchPageOptions = {}): Promise<{ dates: searchconsole_v1.Schema$ApiDataRow[], keywords: searchconsole_v1.Schema$ApiDataRow[] }> {
  const { rowLimit = 5, ...queryOptions } = options
  const [dates, keywords] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({
        period: range.period,
        filters: [{ dimension: 'page', operator: 'equals', expression: formatPageForQuery(url, extractDomain(siteUrl)) }],
        ...queryOptions,
      }),
      dimensions: ['date'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      date: row.keys?.[0] ?? '',
      keys: undefined,
    }))),
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({
        period: range.period,
        filters: [{ dimension: 'page', operator: 'equals', expression: formatPageForQuery(url, extractDomain(siteUrl)) }],
        ...queryOptions,
      }),
      rowLimit,
      dimensions: ['query'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      keyword: row.keys?.[0] || '',
      keys: undefined,
    }))),
  ])
  return { dates, keywords }
}

export interface SearchAppearanceData extends Omit<searchconsole_v1.Schema$ApiDataRow, 'keys'> {
  dimension: 'searchAppearance'
  searchAppearance: string
  keys: null
}

/**
 * Fetches search appearance breakdown (AMP, rich results, etc.) with period comparison.
 */
export async function fetchSearchAppearanceWithComparison(
  auth: GscAuth,
  siteUrl: string,
  range: ResolvedAnalyticsRange,
  options?: QueryOptions,
): Promise<ComparisonResult<SearchAppearanceData>> {
  const [current, previous] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period: range.period, ...options }),
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
    range.prevPeriod
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
          ...createQueryBody({ period: range.prevPeriod, ...options }),
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

function normalizePagePath(page: string | null, domain: string): string | null {
  if (!page)
    return page
  return page.replace('https://', '').replace(domain, '')
}

function extractDomain(siteUrl: string): string {
  return siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function formatPageForQuery(page: string, siteUrl: string): string {
  let p = withBase(page, siteUrl)
  if (p === extractDomain(siteUrl))
    p = `${p}/`
  return withHttps(p)
}

/**
 * Creates a GSC search analytics query request body with standard defaults.
 */
export function createQueryBody(options: QueryOptions = {}): searchconsole_v1.Schema$SearchAnalyticsQueryRequest {
  const {
    domain,
    period = {
      start: dayjs().subtract(30, 'day').toDate(),
      end: dayjs().toDate(),
    },
    filters = [],
    type = 'web',
    dataState = 'all',
    aggregationType = 'byPage',
  } = options

  const allFilters: searchconsole_v1.Schema$ApiDimensionFilter[] = [...filters]

  // Only add page filters for byPage aggregation
  if (aggregationType === 'byPage') {
    allFilters.unshift({
      dimension: 'page',
      operator: 'excludingRegex',
      expression: `#`,
    })

    if (domain) {
      allFilters.unshift({
        dimension: 'page',
        operator: 'includingRegex',
        expression: `^${withoutTrailingSlash(domain).replace(/\./g, '\\.')}/.*`,
      })
    }
  }

  const result: searchconsole_v1.Schema$SearchAnalyticsQueryRequest = {
    type,
    aggregationType,
    dataState,
    startDate: formatDateGsc(period.start),
    endDate: formatDateGsc(period.end),
    rowLimit: 25_000,
  }

  if (allFilters.length > 0) {
    result.dimensionFilterGroups = [{ filters: allFilters }]
  }

  return result
}

// Query builder helpers

/**
 * Helper to add search appearance dimension filter.
 * Use with spread: createQueryBody({ ...withSearchAppearance('AMP'), period })
 */
export function withSearchAppearance(appearance: string): Pick<QueryOptions, 'filters'> {
  return {
    filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: appearance }],
  }
}

/**
 * Helper to set data type (web, image, video, news, discover, googleNews).
 * Use with spread: createQueryBody({ ...withDataType('image'), period })
 */
export function withDataType(type: DataType): Pick<QueryOptions, 'type'> {
  return { type }
}

/**
 * Helper to include fresh/unfinalized data (last 3 days).
 * Use with spread: createQueryBody({ ...withFreshData(), period })
 */
export function withFreshData(): Pick<QueryOptions, 'dataState'> {
  return { dataState: 'all' }
}

/**
 * Helper to use only finalized data (excludes last 3 days).
 * Use with spread: createQueryBody({ ...withFinalData(), period })
 */
export function withFinalData(): Pick<QueryOptions, 'dataState'> {
  return { dataState: 'final' }
}

/**
 * Helper to use byProperty aggregation (domain-level rollup).
 * Use for sc-domain: properties to get true totals.
 * Use with spread: createQueryBody({ ...withPropertyAggregation(), period })
 */
export function withPropertyAggregation(): Pick<QueryOptions, 'aggregationType'> {
  return { aggregationType: 'byProperty' }
}
