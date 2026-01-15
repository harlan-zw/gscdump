import type {
  ComparisonResult,
  CountryData,
  DateData,
  DatesComparisonResult,
  DeviceData,
  FetchKeywordResult,
  FetchPageResult,
  KeywordData,
  PageData,
} from 'gscdump'
import type { GscDb } from './connector'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { countries, percentDifference } from 'gscdump'
import {
  siteDateAnalytics,
  siteDateCountryAnalytics,
  siteDateDeviceAnalytics,
  siteKeywordDateAnalytics,
  siteKeywordPathDateAnalytics,
  sitePathDateAnalytics,
} from './schema'

// Convert DB stored metrics back to API format
function fromGscMetrics(row: { clicks?: number | null, impressions?: number | null, ctr?: number | null, position?: number | null }): { clicks: number, impressions: number, ctr: number, position: number } {
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: (row.ctr ?? 0) / 10000,
    position: (row.position ?? 0) / 100,
  }
}

export interface DateRange {
  startDate: string
  endDate: string
}

function computeTotals(rows: DateData[]): { clicks: number, impressions: number, ctr: number, position: number } {
  if (!rows.length)
    return { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  return {
    clicks: rows.reduce((sum, r) => sum + (r.clicks || 0), 0),
    impressions: rows.reduce((sum, r) => sum + (r.impressions || 0), 0),
    ctr: rows.reduce((sum, r) => sum + (r.ctr || 0), 0) / rows.length,
    position: rows.reduce((sum, r) => sum + (r.position || 0), 0) / rows.length,
  }
}

export async function queryDatesWithComparison(
  db: GscDb,
  siteId: number,
  current: DateRange,
  previous?: DateRange,
): Promise<DatesComparisonResult> {
  const currentRows = await db.select()
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, current.startDate),
      lte(sitePathDateAnalytics.date, current.endDate),
    ))
    .all()

  // Aggregate by date
  const currentByDate = new Map<string, DateData>()
  for (const row of currentRows) {
    const existing = currentByDate.get(row.date)
    const metrics = fromGscMetrics(row)
    if (existing) {
      existing.clicks = (existing.clicks ?? 0) + metrics.clicks
      existing.impressions = (existing.impressions ?? 0) + metrics.impressions
      existing.ctr = ((existing.ctr ?? 0) + metrics.ctr) / 2
      existing.position = ((existing.position ?? 0) + metrics.position) / 2
    }
    else {
      currentByDate.set(row.date, { dimension: 'date' as const, date: row.date, keys: null, ...metrics })
    }
  }

  const currentData = Array.from(currentByDate.values()).sort((a, b) => a.date.localeCompare(b.date))

  let previousData: DateData[] = []
  if (previous) {
    const previousRows = await db.select()
      .from(sitePathDateAnalytics)
      .where(and(
        eq(sitePathDateAnalytics.siteId, siteId),
        gte(sitePathDateAnalytics.date, previous.startDate),
        lte(sitePathDateAnalytics.date, previous.endDate),
      ))
      .all()

    const previousByDate = new Map<string, DateData>()
    for (const row of previousRows) {
      const existing = previousByDate.get(row.date)
      const metrics = fromGscMetrics(row)
      if (existing) {
        existing.clicks = (existing.clicks ?? 0) + metrics.clicks
        existing.impressions = (existing.impressions ?? 0) + metrics.impressions
        existing.ctr = ((existing.ctr ?? 0) + metrics.ctr) / 2
        existing.position = ((existing.position ?? 0) + metrics.position) / 2
      }
      else {
        previousByDate.set(row.date, { dimension: 'date' as const, date: row.date, keys: null, ...metrics })
      }
    }
    previousData = Array.from(previousByDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  }

  const currentTotals = computeTotals(currentData)
  const previousTotals = computeTotals(previousData)

  return {
    current: currentData,
    previous: previousData,
    metadata: {
      currentCount: currentData.length,
      previousCount: previousData.length,
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

export async function queryPagesWithComparison(
  db: GscDb,
  siteId: number,
  current: DateRange,
  previous?: DateRange,
): Promise<ComparisonResult<PageData>> {
  // Get aggregated page data for current period
  const currentRows = await db.select({
    path: sitePathDateAnalytics.path,
    totalClicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${sitePathDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${sitePathDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, current.startDate),
      lte(sitePathDateAnalytics.date, current.endDate),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .orderBy(desc(sql`sum(${sitePathDateAnalytics.clicks})`))
    .all()

  // Get top keyword for each page from keyword-path data
  const keywordsByPage = new Map<string, { keyword: string, position: number }>()
  const keywordPathRows = await db.select({
    path: siteKeywordPathDateAnalytics.path,
    keyword: siteKeywordPathDateAnalytics.keyword,
    totalClicks: sql<number>`sum(${siteKeywordPathDateAnalytics.clicks})`.as('total_clicks'),
    avgPosition: sql<number>`avg(${siteKeywordPathDateAnalytics.position})`.as('avg_position'),
  })
    .from(siteKeywordPathDateAnalytics)
    .where(and(
      eq(siteKeywordPathDateAnalytics.siteId, siteId),
      gte(siteKeywordPathDateAnalytics.date, current.startDate),
      lte(siteKeywordPathDateAnalytics.date, current.endDate),
    ))
    .groupBy(siteKeywordPathDateAnalytics.path, siteKeywordPathDateAnalytics.keyword)
    .orderBy(desc(sql`sum(${siteKeywordPathDateAnalytics.clicks})`))
    .all()

  for (const row of keywordPathRows) {
    if (!keywordsByPage.has(row.path)) {
      keywordsByPage.set(row.path, {
        keyword: row.keyword,
        // @ts-expect-error db0 returns raw column names
        position: (row.avg_position ?? 0) / 100,
      })
    }
  }

  // Get previous period data
  const previousByPath = new Map<string, { clicks: number, impressions: number }>()
  if (previous) {
    const previousRows = await db.select({
      path: sitePathDateAnalytics.path,
      totalClicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('total_clicks'),
      totalImpressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('total_impressions'),
    })
      .from(sitePathDateAnalytics)
      .where(and(
        eq(sitePathDateAnalytics.siteId, siteId),
        gte(sitePathDateAnalytics.date, previous.startDate),
        lte(sitePathDateAnalytics.date, previous.endDate),
      ))
      .groupBy(sitePathDateAnalytics.path)
      .all()

    for (const row of previousRows) {
      previousByPath.set(row.path, {
        // @ts-expect-error db0 returns raw column names
        clicks: row.total_clicks ?? 0,
        // @ts-expect-error db0 returns raw column names
        impressions: row.total_impressions ?? 0,
      })
    }
  }

  const currentData: PageData[] = currentRows.map((row) => {
    // @ts-expect-error db0 returns raw column names
    const clicks = row.total_clicks ?? 0
    // @ts-expect-error db0 returns raw column names
    const impressions = row.total_impressions ?? 0
    const prev = previousByPath.get(row.path)
    const prevClicks = prev?.clicks ?? 0
    const prevImpressions = prev?.impressions ?? 0
    const kw = keywordsByPage.get(row.path)

    return {
      dimension: 'page' as const,
      page: row.path,
      clicks,
      impressions,
      // @ts-expect-error db0 returns raw column names
      ctr: (row.avg_ctr ?? 0) / 10000,
      // @ts-expect-error db0 returns raw column names
      position: (row.avg_position ?? 0) / 100,
      keyword: kw?.keyword,
      keywordPosition: kw?.position,
      prevClicks,
      clicksPercent: percentDifference(clicks, prevClicks),
      prevImpressions,
      impressionsPercent: percentDifference(impressions, prevImpressions),
      keys: null,
    }
  })

  // Find lost pages (in previous but not current)
  const previousData: PageData[] = []
  if (previous) {
    const currentPaths = new Set(currentRows.map(r => r.path))
    for (const [path, prev] of previousByPath) {
      if (!currentPaths.has(path)) {
        previousData.push({
          dimension: 'page' as const,
          page: path,
          clicks: 0,
          impressions: 0,
          ctr: 0,
          position: 0,
          prevClicks: prev.clicks,
          prevImpressions: prev.impressions,
          lost: true,
          keys: null,
        })
      }
      else {
        previousData.push({
          dimension: 'page' as const,
          page: path,
          clicks: prev.clicks,
          impressions: prev.impressions,
          ctr: 0,
          position: 0,
          keys: null,
        })
      }
    }
  }

  return {
    current: currentData,
    previous: previousData,
    metadata: {
      currentCount: currentData.length,
      previousCount: previousData.length,
      keywordMatches: keywordsByPage.size,
    },
  }
}

export async function queryKeywordsWithComparison(
  db: GscDb,
  siteId: number,
  current: DateRange,
  previous?: DateRange,
): Promise<ComparisonResult<KeywordData>> {
  // Get aggregated keyword data for current period
  const currentRows = await db.select({
    keyword: siteKeywordDateAnalytics.keyword,
    totalClicks: sql<number>`sum(${siteKeywordDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteKeywordDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${siteKeywordDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${siteKeywordDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(siteKeywordDateAnalytics)
    .where(and(
      eq(siteKeywordDateAnalytics.siteId, siteId),
      gte(siteKeywordDateAnalytics.date, current.startDate),
      lte(siteKeywordDateAnalytics.date, current.endDate),
    ))
    .groupBy(siteKeywordDateAnalytics.keyword)
    .orderBy(desc(sql`sum(${siteKeywordDateAnalytics.clicks})`))
    .all()

  // Get top page for each keyword from keyword-path data
  const pagesByKeyword = new Map<string, string>()
  const keywordPathRows = await db.select({
    keyword: siteKeywordPathDateAnalytics.keyword,
    path: siteKeywordPathDateAnalytics.path,
    totalClicks: sql<number>`sum(${siteKeywordPathDateAnalytics.clicks})`.as('total_clicks'),
  })
    .from(siteKeywordPathDateAnalytics)
    .where(and(
      eq(siteKeywordPathDateAnalytics.siteId, siteId),
      gte(siteKeywordPathDateAnalytics.date, current.startDate),
      lte(siteKeywordPathDateAnalytics.date, current.endDate),
    ))
    .groupBy(siteKeywordPathDateAnalytics.keyword, siteKeywordPathDateAnalytics.path)
    .orderBy(desc(sql`sum(${siteKeywordPathDateAnalytics.clicks})`))
    .all()

  for (const row of keywordPathRows) {
    if (!pagesByKeyword.has(row.keyword))
      pagesByKeyword.set(row.keyword, row.path)
  }

  // Get previous period data
  const previousByKeyword = new Map<string, { clicks: number, impressions: number, ctr: number, position: number }>()
  if (previous) {
    const previousRows = await db.select({
      keyword: siteKeywordDateAnalytics.keyword,
      totalClicks: sql<number>`sum(${siteKeywordDateAnalytics.clicks})`.as('total_clicks'),
      totalImpressions: sql<number>`sum(${siteKeywordDateAnalytics.impressions})`.as('total_impressions'),
      avgPosition: sql<number>`avg(${siteKeywordDateAnalytics.position})`.as('avg_position'),
      avgCtr: sql<number>`avg(${siteKeywordDateAnalytics.ctr})`.as('avg_ctr'),
    })
      .from(siteKeywordDateAnalytics)
      .where(and(
        eq(siteKeywordDateAnalytics.siteId, siteId),
        gte(siteKeywordDateAnalytics.date, previous.startDate),
        lte(siteKeywordDateAnalytics.date, previous.endDate),
      ))
      .groupBy(siteKeywordDateAnalytics.keyword)
      .all()

    for (const row of previousRows) {
      previousByKeyword.set(row.keyword, {
        // @ts-expect-error db0 returns raw column names
        clicks: row.total_clicks ?? 0,
        // @ts-expect-error db0 returns raw column names
        impressions: row.total_impressions ?? 0,
        // @ts-expect-error db0 returns raw column names
        ctr: (row.avg_ctr ?? 0) / 10000,
        // @ts-expect-error db0 returns raw column names
        position: (row.avg_position ?? 0) / 100,
      })
    }
  }

  const currentData: KeywordData[] = currentRows.map((row) => {
    // @ts-expect-error db0 returns raw column names
    const clicks = row.total_clicks ?? 0
    // @ts-expect-error db0 returns raw column names
    const impressions = row.total_impressions ?? 0
    // @ts-expect-error db0 returns raw column names
    const ctr = (row.avg_ctr ?? 0) / 10000
    // @ts-expect-error db0 returns raw column names
    const position = (row.avg_position ?? 0) / 100
    const prev = previousByKeyword.get(row.keyword)
    const prevPosition = prev?.position ?? 0
    const prevCtr = prev?.ctr ?? 0

    return {
      dimension: 'query' as const,
      keyword: row.keyword,
      clicks,
      impressions,
      ctr,
      position,
      page: pagesByKeyword.get(row.keyword) ?? null,
      positionPercent: percentDifference(position, prevPosition),
      prevPosition,
      ctrPercent: percentDifference(ctr, prevCtr),
      prevCtr,
      keys: null,
    }
  })

  // Find lost keywords
  const previousData: KeywordData[] = []
  if (previous) {
    const currentKeywords = new Set(currentRows.map(r => r.keyword))
    for (const [keyword, prev] of previousByKeyword) {
      if (!currentKeywords.has(keyword)) {
        previousData.push({
          dimension: 'query' as const,
          keyword,
          clicks: 0,
          impressions: 0,
          ctr: 0,
          position: 0,
          page: pagesByKeyword.get(keyword) ?? null,
          lost: true,
          prevCtr: prev.ctr,
          prevPosition: prev.position,
          prevClicks: prev.clicks,
          prevImpressions: prev.impressions,
          keys: null,
        })
      }
      else {
        previousData.push({
          dimension: 'query' as const,
          keyword,
          clicks: prev.clicks,
          impressions: prev.impressions,
          ctr: prev.ctr,
          position: prev.position,
          page: pagesByKeyword.get(keyword) ?? null,
          keys: null,
        })
      }
    }
  }

  return {
    current: currentData,
    previous: previousData,
    metadata: {
      currentCount: currentData.length,
      previousCount: previousData.length,
      pageMatches: pagesByKeyword.size,
    },
  }
}

export async function queryDevicesWithComparison(
  db: GscDb,
  siteId: number,
  current: DateRange,
  previous?: DateRange,
): Promise<ComparisonResult<DeviceData>> {
  const currentRows = await db.select({
    device: siteDateDeviceAnalytics.device,
    totalClicks: sql<number>`sum(${siteDateDeviceAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteDateDeviceAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${siteDateDeviceAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${siteDateDeviceAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(siteDateDeviceAnalytics)
    .where(and(
      eq(siteDateDeviceAnalytics.siteId, siteId),
      gte(siteDateDeviceAnalytics.date, current.startDate),
      lte(siteDateDeviceAnalytics.date, current.endDate),
    ))
    .groupBy(siteDateDeviceAnalytics.device)
    .orderBy(desc(sql`sum(${siteDateDeviceAnalytics.clicks})`))
    .all()

  const currentData: DeviceData[] = currentRows.map(row => ({
    dimension: 'device' as const,
    device: row.device,
    // @ts-expect-error db0 returns raw column names
    clicks: row.total_clicks ?? 0,
    // @ts-expect-error db0 returns raw column names
    impressions: row.total_impressions ?? 0,
    // @ts-expect-error db0 returns raw column names
    ctr: (row.avg_ctr ?? 0) / 10000,
    // @ts-expect-error db0 returns raw column names
    position: (row.avg_position ?? 0) / 100,
    keys: null,
  }))

  let previousData: DeviceData[] = []
  if (previous) {
    const previousRows = await db.select({
      device: siteDateDeviceAnalytics.device,
      totalClicks: sql<number>`sum(${siteDateDeviceAnalytics.clicks})`.as('total_clicks'),
      totalImpressions: sql<number>`sum(${siteDateDeviceAnalytics.impressions})`.as('total_impressions'),
      avgPosition: sql<number>`avg(${siteDateDeviceAnalytics.position})`.as('avg_position'),
      avgCtr: sql<number>`avg(${siteDateDeviceAnalytics.ctr})`.as('avg_ctr'),
    })
      .from(siteDateDeviceAnalytics)
      .where(and(
        eq(siteDateDeviceAnalytics.siteId, siteId),
        gte(siteDateDeviceAnalytics.date, previous.startDate),
        lte(siteDateDeviceAnalytics.date, previous.endDate),
      ))
      .groupBy(siteDateDeviceAnalytics.device)
      .orderBy(desc(sql`sum(${siteDateDeviceAnalytics.clicks})`))
      .all()

    previousData = previousRows.map(row => ({
      dimension: 'device' as const,
      device: row.device,
      // @ts-expect-error db0 returns raw column names
      clicks: row.total_clicks ?? 0,
      // @ts-expect-error db0 returns raw column names
      impressions: row.total_impressions ?? 0,
      // @ts-expect-error db0 returns raw column names
      ctr: (row.avg_ctr ?? 0) / 10000,
      // @ts-expect-error db0 returns raw column names
      position: (row.avg_position ?? 0) / 100,
      keys: null,
    }))
  }

  return {
    current: currentData,
    previous: previousData,
    metadata: {
      currentCount: currentData.length,
      previousCount: previousData.length,
    },
  }
}

export async function queryCountriesWithComparison(
  db: GscDb,
  siteId: number,
  current: DateRange,
  previous?: DateRange,
  limit = 5,
): Promise<ComparisonResult<CountryData>> {
  const currentRows = await db.select({
    country: siteDateCountryAnalytics.country,
    totalClicks: sql<number>`sum(${siteDateCountryAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteDateCountryAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${siteDateCountryAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${siteDateCountryAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(siteDateCountryAnalytics)
    .where(and(
      eq(siteDateCountryAnalytics.siteId, siteId),
      gte(siteDateCountryAnalytics.date, current.startDate),
      lte(siteDateCountryAnalytics.date, current.endDate),
    ))
    .groupBy(siteDateCountryAnalytics.country)
    .orderBy(desc(sql`sum(${siteDateCountryAnalytics.clicks})`))
    .limit(limit)
    .all()

  // Note: We don't have country+keyword data in the schema, so we can't compute keyword counts
  const keywordCountsByCountry = new Map<string, number>()

  const currentData: CountryData[] = currentRows.map((row) => {
    const alpha3Code = row.country
    const countryInfo = countries.find(c => c['alpha-3'].toLowerCase() === alpha3Code.toLowerCase())
    return {
      dimension: 'country' as const,
      countryCodeGsc: alpha3Code,
      country: countryInfo?.name || alpha3Code,
      countryCode: countryInfo?.['alpha-2'] || alpha3Code,
      // @ts-expect-error db0 returns raw column names
      clicks: row.total_clicks ?? 0,
      // @ts-expect-error db0 returns raw column names
      impressions: row.total_impressions ?? 0,
      // @ts-expect-error db0 returns raw column names
      ctr: (row.avg_ctr ?? 0) / 10000,
      // @ts-expect-error db0 returns raw column names
      position: (row.avg_position ?? 0) / 100,
      keywords: keywordCountsByCountry.get(alpha3Code) ?? 0,
      keys: null,
    }
  })

  let previousData: CountryData[] = []
  if (previous) {
    const previousRows = await db.select({
      country: siteDateCountryAnalytics.country,
      totalClicks: sql<number>`sum(${siteDateCountryAnalytics.clicks})`.as('total_clicks'),
      totalImpressions: sql<number>`sum(${siteDateCountryAnalytics.impressions})`.as('total_impressions'),
      avgPosition: sql<number>`avg(${siteDateCountryAnalytics.position})`.as('avg_position'),
      avgCtr: sql<number>`avg(${siteDateCountryAnalytics.ctr})`.as('avg_ctr'),
    })
      .from(siteDateCountryAnalytics)
      .where(and(
        eq(siteDateCountryAnalytics.siteId, siteId),
        gte(siteDateCountryAnalytics.date, previous.startDate),
        lte(siteDateCountryAnalytics.date, previous.endDate),
      ))
      .groupBy(siteDateCountryAnalytics.country)
      .orderBy(desc(sql`sum(${siteDateCountryAnalytics.clicks})`))
      .limit(limit)
      .all()

    previousData = previousRows.map((row) => {
      const alpha3Code = row.country
      const countryInfo = countries.find(c => c['alpha-3'].toLowerCase() === alpha3Code.toLowerCase())
      return {
        dimension: 'country' as const,
        countryCodeGsc: alpha3Code,
        country: countryInfo?.name || alpha3Code,
        countryCode: countryInfo?.['alpha-2'] || alpha3Code,
        // @ts-expect-error db0 returns raw column names
        clicks: row.total_clicks ?? 0,
        // @ts-expect-error db0 returns raw column names
        impressions: row.total_impressions ?? 0,
        // @ts-expect-error db0 returns raw column names
        ctr: (row.avg_ctr ?? 0) / 10000,
        // @ts-expect-error db0 returns raw column names
        position: (row.avg_position ?? 0) / 100,
        keys: null,
      }
    })
  }

  return {
    current: currentData,
    previous: previousData,
    metadata: {
      currentCount: currentData.length,
      previousCount: previousData.length,
      totalKeywords: Array.from(keywordCountsByCountry.values()).reduce((sum, k) => sum + k, 0),
    },
  }
}

// Simple page list (mirrors fetchPages)
export async function queryPages(
  db: GscDb,
  siteId: number,
  range: DateRange,
): Promise<{ page: string, clicks: number, impressions: number, ctr: number, position: number }[]> {
  const rows = await db.select({
    path: sitePathDateAnalytics.path,
    totalClicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${sitePathDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${sitePathDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, range.startDate),
      lte(sitePathDateAnalytics.date, range.endDate),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .orderBy(desc(sql`sum(${sitePathDateAnalytics.clicks})`))
    .all()

  return rows.map(row => ({
    page: row.path,
    // @ts-expect-error db0 returns raw column names
    clicks: row.total_clicks ?? 0,
    // @ts-expect-error db0 returns raw column names
    impressions: row.total_impressions ?? 0,
    // @ts-expect-error db0 returns raw column names
    ctr: (row.avg_ctr ?? 0) / 10000,
    // @ts-expect-error db0 returns raw column names
    position: (row.avg_position ?? 0) / 100,
  }))
}

// Keyword drill-down (mirrors fetchKeyword)
export async function queryKeyword(
  db: GscDb,
  siteId: number,
  range: DateRange,
  keyword: string,
): Promise<FetchKeywordResult> {
  // Daily trend for keyword
  const dateRows = await db.select()
    .from(siteKeywordDateAnalytics)
    .where(and(
      eq(siteKeywordDateAnalytics.siteId, siteId),
      eq(siteKeywordDateAnalytics.keyword, keyword),
      gte(siteKeywordDateAnalytics.date, range.startDate),
      lte(siteKeywordDateAnalytics.date, range.endDate),
    ))
    .orderBy(siteKeywordDateAnalytics.date)
    .all()

  const dates: DateData[] = dateRows.map(row => ({
    dimension: 'date' as const,
    date: row.date,
    keys: null,
    ...fromGscMetrics(row),
  }))

  // Top pages for this keyword
  const pageRows = await db.select({
    path: siteKeywordPathDateAnalytics.path,
    totalClicks: sql<number>`sum(${siteKeywordPathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteKeywordPathDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${siteKeywordPathDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${siteKeywordPathDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(siteKeywordPathDateAnalytics)
    .where(and(
      eq(siteKeywordPathDateAnalytics.siteId, siteId),
      eq(siteKeywordPathDateAnalytics.keyword, keyword),
      gte(siteKeywordPathDateAnalytics.date, range.startDate),
      lte(siteKeywordPathDateAnalytics.date, range.endDate),
    ))
    .groupBy(siteKeywordPathDateAnalytics.path)
    .orderBy(desc(sql`sum(${siteKeywordPathDateAnalytics.clicks})`))
    .limit(5)
    .all()

  const pages = pageRows.map(row => ({
    page: row.path,
    // @ts-expect-error db0 returns raw column names
    clicks: row.total_clicks ?? 0,
    // @ts-expect-error db0 returns raw column names
    impressions: row.total_impressions ?? 0,
    // @ts-expect-error db0 returns raw column names
    ctr: (row.avg_ctr ?? 0) / 10000,
    // @ts-expect-error db0 returns raw column names
    position: (row.avg_position ?? 0) / 100,
    keys: null as null,
  }))

  return { dates, pages }
}

// Page drill-down (mirrors fetchPage)
export async function queryPage(
  db: GscDb,
  siteId: number,
  range: DateRange,
  path: string,
): Promise<FetchPageResult> {
  // Daily trend for page
  const dateRows = await db.select()
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      eq(sitePathDateAnalytics.path, path),
      gte(sitePathDateAnalytics.date, range.startDate),
      lte(sitePathDateAnalytics.date, range.endDate),
    ))
    .orderBy(sitePathDateAnalytics.date)
    .all()

  const dates: DateData[] = dateRows.map(row => ({
    dimension: 'date' as const,
    date: row.date,
    keys: null,
    ...fromGscMetrics(row),
  }))

  // Top keywords for this page
  const keywordRows = await db.select({
    keyword: siteKeywordPathDateAnalytics.keyword,
    totalClicks: sql<number>`sum(${siteKeywordPathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteKeywordPathDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${siteKeywordPathDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${siteKeywordPathDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(siteKeywordPathDateAnalytics)
    .where(and(
      eq(siteKeywordPathDateAnalytics.siteId, siteId),
      eq(siteKeywordPathDateAnalytics.path, path),
      gte(siteKeywordPathDateAnalytics.date, range.startDate),
      lte(siteKeywordPathDateAnalytics.date, range.endDate),
    ))
    .groupBy(siteKeywordPathDateAnalytics.keyword)
    .orderBy(desc(sql`sum(${siteKeywordPathDateAnalytics.clicks})`))
    .limit(5)
    .all()

  const keywords = keywordRows.map(row => ({
    keyword: row.keyword,
    // @ts-expect-error db0 returns raw column names
    clicks: row.total_clicks ?? 0,
    // @ts-expect-error db0 returns raw column names
    impressions: row.total_impressions ?? 0,
    // @ts-expect-error db0 returns raw column names
    ctr: (row.avg_ctr ?? 0) / 10000,
    // @ts-expect-error db0 returns raw column names
    position: (row.avg_position ?? 0) / 100,
    keys: null as null,
  }))

  return { dates, keywords }
}

// Check if DB has data for a given date range
export async function hasDataForRange(
  db: GscDb,
  siteId: number,
  range: DateRange,
): Promise<boolean> {
  const rows = await db.select({ count: sql<number>`count(*)`.as('count') })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, range.startDate),
      lte(sitePathDateAnalytics.date, range.endDate),
    ))
    .all()
  const row = rows[0]
  return (row?.count ?? 0) > 0
}

// Query+Page rows for cannibalization/zero-click analysis
export interface QueryPageRow {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export async function queryQueryPageRows(
  db: GscDb,
  siteId: number,
  range: DateRange,
): Promise<QueryPageRow[]> {
  const rows = await db.select({
    keyword: siteKeywordPathDateAnalytics.keyword,
    path: siteKeywordPathDateAnalytics.path,
    totalClicks: sql<number>`sum(${siteKeywordPathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteKeywordPathDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${siteKeywordPathDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${siteKeywordPathDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(siteKeywordPathDateAnalytics)
    .where(and(
      eq(siteKeywordPathDateAnalytics.siteId, siteId),
      gte(siteKeywordPathDateAnalytics.date, range.startDate),
      lte(siteKeywordPathDateAnalytics.date, range.endDate),
    ))
    .groupBy(siteKeywordPathDateAnalytics.keyword, siteKeywordPathDateAnalytics.path)
    .orderBy(desc(sql`sum(${siteKeywordPathDateAnalytics.clicks})`))
    .all()

  return rows.map(row => ({
    query: row.keyword,
    page: row.path,
    // @ts-expect-error db0 returns raw column names
    clicks: row.total_clicks ?? 0,
    // @ts-expect-error db0 returns raw column names
    impressions: row.total_impressions ?? 0,
    // @ts-expect-error db0 returns raw column names
    ctr: (row.avg_ctr ?? 0) / 10000,
    // @ts-expect-error db0 returns raw column names
    position: (row.avg_position ?? 0) / 100,
  }))
}

// Date rows for seasonality analysis
export interface DateRow {
  date: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export async function queryDateRows(
  db: GscDb,
  siteId: number,
  range: DateRange,
): Promise<DateRow[]> {
  const rows = await db.select()
    .from(siteDateAnalytics)
    .where(and(
      eq(siteDateAnalytics.siteId, siteId),
      gte(siteDateAnalytics.date, range.startDate),
      lte(siteDateAnalytics.date, range.endDate),
    ))
    .orderBy(siteDateAnalytics.date)
    .all()

  return rows.map(row => ({
    date: row.date,
    ...fromGscMetrics(row),
  }))
}
