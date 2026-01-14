import type { GscDb } from './connector'
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm'
import {
  siteDateAnalytics,
  siteDateCountryAnalytics,
  siteDateDeviceAnalytics,
  siteKeywordDateAnalytics,
  sitePathDateAnalytics,
  sites,
} from './schema'

export function getSiteByProperty(db: GscDb, property: string) {
  return db.select()
    .from(sites)
    .where(eq(sites.property, property))
    .get()
}

export function getSiteById(db: GscDb, siteId: number) {
  return db.select()
    .from(sites)
    .where(eq(sites.siteId, siteId))
    .get()
}

export function getAllSites(db: GscDb) {
  return db.select().from(sites).all()
}

export function getPageTrend(db: GscDb, siteId: number, path: string, startDate: string, endDate: string) {
  return db.select()
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      eq(sitePathDateAnalytics.path, path),
      gte(sitePathDateAnalytics.date, startDate),
      lte(sitePathDateAnalytics.date, endDate),
    ))
    .orderBy(sitePathDateAnalytics.date)
    .all()
}

export function getTopPages(db: GscDb, siteId: number, startDate: string, endDate: string, limit = 100) {
  return db.select({
    path: sitePathDateAnalytics.path,
    totalClicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${sitePathDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${sitePathDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, startDate),
      lte(sitePathDateAnalytics.date, endDate),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .orderBy(desc(sql`sum(${sitePathDateAnalytics.clicks})`))
    .limit(limit)
    .all()
}

export function getKeywordTrend(db: GscDb, siteId: number, keyword: string, startDate: string, endDate: string) {
  return db.select()
    .from(siteKeywordDateAnalytics)
    .where(and(
      eq(siteKeywordDateAnalytics.siteId, siteId),
      eq(siteKeywordDateAnalytics.keyword, keyword),
      gte(siteKeywordDateAnalytics.date, startDate),
      lte(siteKeywordDateAnalytics.date, endDate),
    ))
    .orderBy(siteKeywordDateAnalytics.date)
    .all()
}

export function getTopKeywords(db: GscDb, siteId: number, startDate: string, endDate: string, limit = 100) {
  return db.select({
    keyword: siteKeywordDateAnalytics.keyword,
    totalClicks: sql<number>`sum(${siteKeywordDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteKeywordDateAnalytics.impressions})`.as('total_impressions'),
    avgPosition: sql<number>`avg(${siteKeywordDateAnalytics.position})`.as('avg_position'),
    avgCtr: sql<number>`avg(${siteKeywordDateAnalytics.ctr})`.as('avg_ctr'),
  })
    .from(siteKeywordDateAnalytics)
    .where(and(
      eq(siteKeywordDateAnalytics.siteId, siteId),
      gte(siteKeywordDateAnalytics.date, startDate),
      lte(siteKeywordDateAnalytics.date, endDate),
    ))
    .groupBy(siteKeywordDateAnalytics.keyword)
    .orderBy(desc(sql`sum(${siteKeywordDateAnalytics.clicks})`))
    .limit(limit)
    .all()
}

export function getSiteDailyTotals(db: GscDb, siteId: number, startDate: string, endDate: string) {
  return db.select()
    .from(siteDateAnalytics)
    .where(and(
      eq(siteDateAnalytics.siteId, siteId),
      gte(siteDateAnalytics.date, startDate),
      lte(siteDateAnalytics.date, endDate),
    ))
    .orderBy(siteDateAnalytics.date)
    .all()
}

export function getCountryBreakdown(db: GscDb, siteId: number, startDate: string, endDate: string) {
  return db.select({
    country: siteDateCountryAnalytics.country,
    totalClicks: sql<number>`sum(${siteDateCountryAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteDateCountryAnalytics.impressions})`.as('total_impressions'),
  })
    .from(siteDateCountryAnalytics)
    .where(and(
      eq(siteDateCountryAnalytics.siteId, siteId),
      gte(siteDateCountryAnalytics.date, startDate),
      lte(siteDateCountryAnalytics.date, endDate),
    ))
    .groupBy(siteDateCountryAnalytics.country)
    .orderBy(desc(sql`sum(${siteDateCountryAnalytics.clicks})`))
    .all()
}

export function getDeviceBreakdown(db: GscDb, siteId: number, startDate: string, endDate: string) {
  return db.select({
    device: siteDateDeviceAnalytics.device,
    totalClicks: sql<number>`sum(${siteDateDeviceAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${siteDateDeviceAnalytics.impressions})`.as('total_impressions'),
  })
    .from(siteDateDeviceAnalytics)
    .where(and(
      eq(siteDateDeviceAnalytics.siteId, siteId),
      gte(siteDateDeviceAnalytics.date, startDate),
      lte(siteDateDeviceAnalytics.date, endDate),
    ))
    .groupBy(siteDateDeviceAnalytics.device)
    .orderBy(desc(sql`sum(${siteDateDeviceAnalytics.clicks})`))
    .all()
}

export async function comparePeriods(
  db: GscDb,
  siteId: number,
  current: { start: string, end: string },
  previous: { start: string, end: string },
) {
  const currentData = await db.select({
    totalClicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('total_impressions'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, current.start),
      lte(sitePathDateAnalytics.date, current.end),
    ))
    .get()

  const previousData = await db.select({
    totalClicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('total_clicks'),
    totalImpressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('total_impressions'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, previous.start),
      lte(sitePathDateAnalytics.date, previous.end),
    ))
    .get()

  return {
    current: currentData,
    previous: previousData,
    diff: {
      // @ts-expect-error db0 drizzle returns raw column names
      clicks: (currentData?.total_clicks ?? 0) - (previousData?.total_clicks ?? 0),
      // @ts-expect-error db0 drizzle returns raw column names
      impressions: (currentData?.total_impressions ?? 0) - (previousData?.total_impressions ?? 0),
    },
  }
}

export function pruneOldData(db: GscDb, cutoffDate: string) {
  return Promise.all([
    db.delete(sitePathDateAnalytics).where(lte(sitePathDateAnalytics.date, cutoffDate)),
    db.delete(siteKeywordDateAnalytics).where(lte(siteKeywordDateAnalytics.date, cutoffDate)),
    db.delete(siteDateCountryAnalytics).where(lte(siteDateCountryAnalytics.date, cutoffDate)),
    db.delete(siteDateDeviceAnalytics).where(lte(siteDateDeviceAnalytics.date, cutoffDate)),
    db.delete(siteDateAnalytics).where(lte(siteDateAnalytics.date, cutoffDate)),
  ])
}

// ============================================
// Rollup Aggregations
// ============================================

export interface RollupRow {
  period: string
  clicks: number
  impressions: number
  avgCtr: number
  avgPosition: number
}

/**
 * Get weekly aggregated metrics for a site.
 * Returns data grouped by ISO week (YYYY-Www format).
 */
export function queryWeeklyRollup(db: GscDb, siteId: number, startDate: string, endDate: string): Promise<RollupRow[]> {
  return db.select({
    period: sql<string>`strftime('%Y-W%W', ${sitePathDateAnalytics.date})`.as('period'),
    clicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('clicks'),
    impressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('impressions'),
    avgCtr: sql<number>`avg(${sitePathDateAnalytics.ctr})`.as('avg_ctr'),
    avgPosition: sql<number>`avg(${sitePathDateAnalytics.position})`.as('avg_position'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, startDate),
      lte(sitePathDateAnalytics.date, endDate),
    ))
    .groupBy(sql`strftime('%Y-W%W', ${sitePathDateAnalytics.date})`)
    .orderBy(sql`strftime('%Y-W%W', ${sitePathDateAnalytics.date})`)
    .all()
}

/**
 * Get monthly aggregated metrics for a site.
 * Returns data grouped by month (YYYY-MM format).
 */
export function queryMonthlyRollup(db: GscDb, siteId: number, startDate: string, endDate: string): Promise<RollupRow[]> {
  return db.select({
    period: sql<string>`strftime('%Y-%m', ${sitePathDateAnalytics.date})`.as('period'),
    clicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('clicks'),
    impressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('impressions'),
    avgCtr: sql<number>`avg(${sitePathDateAnalytics.ctr})`.as('avg_ctr'),
    avgPosition: sql<number>`avg(${sitePathDateAnalytics.position})`.as('avg_position'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, startDate),
      lte(sitePathDateAnalytics.date, endDate),
    ))
    .groupBy(sql`strftime('%Y-%m', ${sitePathDateAnalytics.date})`)
    .orderBy(sql`strftime('%Y-%m', ${sitePathDateAnalytics.date})`)
    .all()
}

// ============================================
// Anomaly Detection
// ============================================

export interface SignificantChange {
  type: 'page' | 'keyword'
  key: string // path or keyword
  currentClicks: number
  previousClicks: number
  changePercent: number
}

/**
 * Find pages/keywords with significant changes between two periods.
 * Returns items where the percentage change exceeds the threshold.
 * Positive threshold finds increases, negative finds decreases.
 */
export async function findSignificantChanges(
  db: GscDb,
  siteId: number,
  current: { start: string, end: string },
  previous: { start: string, end: string },
  options: { threshold?: number, type?: 'pages' | 'keywords' | 'both', limit?: number } = {},
): Promise<SignificantChange[]> {
  const { threshold = 50, type = 'both', limit = 50 } = options
  const results: SignificantChange[] = []

  if (type === 'pages' || type === 'both') {
    // Get current period page clicks
    const currentPages = await db.select({
      path: sitePathDateAnalytics.path,
      clicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('clicks'),
    })
      .from(sitePathDateAnalytics)
      .where(and(
        eq(sitePathDateAnalytics.siteId, siteId),
        gte(sitePathDateAnalytics.date, current.start),
        lte(sitePathDateAnalytics.date, current.end),
      ))
      .groupBy(sitePathDateAnalytics.path)
      .all()

    // Get previous period page clicks
    const previousPages = await db.select({
      path: sitePathDateAnalytics.path,
      clicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('clicks'),
    })
      .from(sitePathDateAnalytics)
      .where(and(
        eq(sitePathDateAnalytics.siteId, siteId),
        gte(sitePathDateAnalytics.date, previous.start),
        lte(sitePathDateAnalytics.date, previous.end),
      ))
      .groupBy(sitePathDateAnalytics.path)
      .all()

    const prevMap = new Map(previousPages.map(p => [p.path, p.clicks ?? 0]))

    for (const page of currentPages) {
      const prevClicks = prevMap.get(page.path) ?? 0
      const currentClicks = page.clicks ?? 0
      if (prevClicks > 0) {
        const changePercent = ((currentClicks - prevClicks) / prevClicks) * 100
        if (Math.abs(changePercent) >= Math.abs(threshold)) {
          results.push({
            type: 'page',
            key: page.path,
            currentClicks,
            previousClicks: prevClicks,
            changePercent,
          })
        }
      }
    }
  }

  if (type === 'keywords' || type === 'both') {
    // Get current period keyword clicks
    const currentKeywords = await db.select({
      keyword: siteKeywordDateAnalytics.keyword,
      clicks: sql<number>`sum(${siteKeywordDateAnalytics.clicks})`.as('clicks'),
    })
      .from(siteKeywordDateAnalytics)
      .where(and(
        eq(siteKeywordDateAnalytics.siteId, siteId),
        gte(siteKeywordDateAnalytics.date, current.start),
        lte(siteKeywordDateAnalytics.date, current.end),
      ))
      .groupBy(siteKeywordDateAnalytics.keyword)
      .all()

    // Get previous period keyword clicks
    const previousKeywords = await db.select({
      keyword: siteKeywordDateAnalytics.keyword,
      clicks: sql<number>`sum(${siteKeywordDateAnalytics.clicks})`.as('clicks'),
    })
      .from(siteKeywordDateAnalytics)
      .where(and(
        eq(siteKeywordDateAnalytics.siteId, siteId),
        gte(siteKeywordDateAnalytics.date, previous.start),
        lte(siteKeywordDateAnalytics.date, previous.end),
      ))
      .groupBy(siteKeywordDateAnalytics.keyword)
      .all()

    const prevMap = new Map(previousKeywords.map(k => [k.keyword, k.clicks ?? 0]))

    for (const kw of currentKeywords) {
      const prevClicks = prevMap.get(kw.keyword) ?? 0
      const currentClicks = kw.clicks ?? 0
      if (prevClicks > 0) {
        const changePercent = ((currentClicks - prevClicks) / prevClicks) * 100
        if (Math.abs(changePercent) >= Math.abs(threshold)) {
          results.push({
            type: 'keyword',
            key: kw.keyword,
            currentClicks,
            previousClicks: prevClicks,
            changePercent,
          })
        }
      }
    }
  }

  // Sort by absolute change and limit
  return results
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, limit)
}

export interface LostPage {
  path: string
  previousClicks: number
  previousImpressions: number
  lastSeen: string
}

/**
 * Find pages that had traffic in the previous period but not in the current period.
 */
export async function findLostPages(
  db: GscDb,
  siteId: number,
  current: { start: string, end: string },
  previous: { start: string, end: string },
  options: { minClicks?: number, limit?: number } = {},
): Promise<LostPage[]> {
  const { minClicks = 1, limit = 50 } = options

  // Get pages with traffic in previous period
  const previousPages = await db.select({
    path: sitePathDateAnalytics.path,
    clicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('clicks'),
    impressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('impressions'),
    lastSeen: sql<string>`max(${sitePathDateAnalytics.date})`.as('last_seen'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, previous.start),
      lte(sitePathDateAnalytics.date, previous.end),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .having(sql`sum(${sitePathDateAnalytics.clicks}) >= ${minClicks}`)
    .all()

  // Get pages with traffic in current period
  const currentPages = await db.select({
    path: sitePathDateAnalytics.path,
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, current.start),
      lte(sitePathDateAnalytics.date, current.end),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .having(sql`sum(${sitePathDateAnalytics.clicks}) >= 1`)
    .all()

  const currentPaths = new Set(currentPages.map(p => p.path))

  return previousPages
    .filter(p => !currentPaths.has(p.path))
    .map(p => ({
      path: p.path,
      previousClicks: p.clicks ?? 0,
      previousImpressions: p.impressions ?? 0,
      lastSeen: p.lastSeen ?? '',
    }))
    .sort((a, b) => b.previousClicks - a.previousClicks)
    .slice(0, limit)
}

export interface NewPage {
  path: string
  clicks: number
  impressions: number
  firstSeen: string
}

/**
 * Find pages that have traffic in the current period but not in the previous period.
 */
export async function findNewPages(
  db: GscDb,
  siteId: number,
  current: { start: string, end: string },
  previous: { start: string, end: string },
  options: { minClicks?: number, limit?: number } = {},
): Promise<NewPage[]> {
  const { minClicks = 1, limit = 50 } = options

  // Get pages with traffic in current period
  const currentPages = await db.select({
    path: sitePathDateAnalytics.path,
    clicks: sql<number>`sum(${sitePathDateAnalytics.clicks})`.as('clicks'),
    impressions: sql<number>`sum(${sitePathDateAnalytics.impressions})`.as('impressions'),
    firstSeen: sql<string>`min(${sitePathDateAnalytics.date})`.as('first_seen'),
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, current.start),
      lte(sitePathDateAnalytics.date, current.end),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .having(sql`sum(${sitePathDateAnalytics.clicks}) >= ${minClicks}`)
    .all()

  // Get pages with traffic in previous period
  const previousPages = await db.select({
    path: sitePathDateAnalytics.path,
  })
    .from(sitePathDateAnalytics)
    .where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      gte(sitePathDateAnalytics.date, previous.start),
      lte(sitePathDateAnalytics.date, previous.end),
    ))
    .groupBy(sitePathDateAnalytics.path)
    .having(sql`sum(${sitePathDateAnalytics.clicks}) >= 1`)
    .all()

  const previousPaths = new Set(previousPages.map(p => p.path))

  return currentPages
    .filter(p => !previousPaths.has(p.path))
    .map(p => ({
      path: p.path,
      clicks: p.clicks ?? 0,
      impressions: p.impressions ?? 0,
      firstSeen: p.firstSeen ?? '',
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, limit)
}

// ============================================
// Data Management
// ============================================

/**
 * Prune old data from all analytics tables, keeping only data newer than retentionDays.
 * Returns the cutoff date used.
 */
export async function pruneOldDataByDays(db: GscDb, siteId: number, retentionDays: number): Promise<{ cutoffDate: string, deleted: number[] }> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const results = await Promise.all([
    db.delete(sitePathDateAnalytics).where(and(
      eq(sitePathDateAnalytics.siteId, siteId),
      lt(sitePathDateAnalytics.date, cutoffDate),
    )),
    db.delete(siteKeywordDateAnalytics).where(and(
      eq(siteKeywordDateAnalytics.siteId, siteId),
      lt(siteKeywordDateAnalytics.date, cutoffDate),
    )),
    db.delete(siteDateCountryAnalytics).where(and(
      eq(siteDateCountryAnalytics.siteId, siteId),
      lt(siteDateCountryAnalytics.date, cutoffDate),
    )),
    db.delete(siteDateDeviceAnalytics).where(and(
      eq(siteDateDeviceAnalytics.siteId, siteId),
      lt(siteDateDeviceAnalytics.date, cutoffDate),
    )),
    db.delete(siteDateAnalytics).where(and(
      eq(siteDateAnalytics.siteId, siteId),
      lt(siteDateAnalytics.date, cutoffDate),
    )),
  ])

  return { cutoffDate, deleted: results.map(r => r?.rowsAffected ?? 0) }
}

/**
 * Vacuum the database to reclaim space after deleting data.
 * Note: This may take a while for large databases.
 */
export async function vacuumDb(db: GscDb): Promise<void> {
  await db.run(sql`VACUUM`)
}
