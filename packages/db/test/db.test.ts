import type { Database } from 'db0'
import type { GoogleSearchConsoleDatabase } from '../src/connector'
import { createDatabase } from 'db0'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { drizzle } from 'db0/integrations/drizzle'
import { describe, expect, it } from 'vitest'
import {
  comparePeriods,
  getAllSites,
  getCountryBreakdown,
  getDeviceBreakdown,
  getKeywordTrend,
  getPageTrend,
  getSiteByProperty,
  getTopKeywords,
  getTopPages,
  pruneOldData,
} from '../src/queries'
import {
  siteDateCountryAnalytics,
  siteDateDeviceAnalytics,
  siteKeywordDateAnalytics,
  sitePathDateAnalytics,
  sites,
} from '../src/schema'
import { getLastSyncedDate, updateLastSynced } from '../src/sync'

function createTestDb(): { db0: Database, db: GoogleSearchConsoleDatabase } {
  const db0 = createDatabase(betterSqlite3({ name: ':memory:' }))
  const db = drizzle(db0) as GoogleSearchConsoleDatabase
  return { db0, db }
}

async function setupSchema(db0: Database) {
  await db0.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      site_id INTEGER PRIMARY KEY,
      property TEXT NOT NULL UNIQUE,
      domain TEXT,
      sitemaps TEXT,
      last_synced INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `)

  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_path_date_analytics (
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      path TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(site_id, date, path)
    )
  `)

  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_keyword_date_analytics (
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      keyword TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(site_id, date, keyword)
    )
  `)

  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_date_country_analytics (
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      country TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(site_id, date, country)
    )
  `)

  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_date_device_analytics (
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      device TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(site_id, date, device)
    )
  `)

  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_date_analytics (
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      mobile_clicks INTEGER,
      mobile_impressions INTEGER,
      desktop_clicks INTEGER,
      desktop_impressions INTEGER,
      tablet_clicks INTEGER,
      tablet_impressions INTEGER,
      keywords INTEGER,
      pages INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(site_id, date)
    )
  `)
}

describe('connector', () => {
  it('creates database instance', () => {
    const { db } = createTestDb()
    expect(db).toBeDefined()
    expect(typeof db.select).toBe('function')
    expect(typeof db.insert).toBe('function')
  })
})

describe('schema', () => {
  it('defines all required tables', () => {
    expect(sites).toBeDefined()
    expect(sitePathDateAnalytics).toBeDefined()
    expect(siteKeywordDateAnalytics).toBeDefined()
    expect(siteDateCountryAnalytics).toBeDefined()
    expect(siteDateDeviceAnalytics).toBeDefined()
  })
})

describe('queries', () => {
  it('getAllSites returns empty array initially', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    const result = await getAllSites(db)
    expect(result).toEqual([])
  })

  it('inserts and retrieves site', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sites).values({
      siteId: 1,
      property: 'sc-domain:example.com',
      domain: 'example.com',
      sitemaps: ['https://example.com/sitemap.xml'],
    })

    const result = await getSiteByProperty(db, 'sc-domain:example.com')
    expect(result?.property).toBe('sc-domain:example.com')
    expect(result?.domain).toBe('example.com')
  })

  it('getSiteById returns site', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sites).values({
      siteId: 1,
      property: 'sc-domain:test.com',
      domain: 'test.com',
    })

    // Use db.select().all() since db0 integration uses async queries
    const allSites = await db.select().from(sites).all()
    expect(allSites).toHaveLength(1)
    // db0 drizzle returns raw column names (snake_case)
    expect(allSites[0].site_id).toBe(1)
  })

  it('getPageTrend returns page analytics', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sitePathDateAnalytics).values([
      { siteId: 1, date: '2024-01-01', path: '/test', clicks: 10, impressions: 100 },
      { siteId: 1, date: '2024-01-02', path: '/test', clicks: 15, impressions: 150 },
    ])

    const result = await getPageTrend(db, 1, '/test', '2024-01-01', '2024-01-02')
    expect(result).toHaveLength(2)
    expect(result[0].clicks).toBe(10)
    expect(result[1].clicks).toBe(15)
  })

  it('getTopPages aggregates by path', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sitePathDateAnalytics).values([
      { siteId: 1, date: '2024-01-01', path: '/page1', clicks: 50, impressions: 500 },
      { siteId: 1, date: '2024-01-02', path: '/page1', clicks: 50, impressions: 500 },
      { siteId: 1, date: '2024-01-01', path: '/page2', clicks: 10, impressions: 100 },
    ])

    const result = await getTopPages(db, 1, '2024-01-01', '2024-01-02')
    expect(result).toHaveLength(2)
    expect(result[0].path).toBe('/page1')
    // db0 drizzle returns raw column names from the sql template
    expect(result[0].total_clicks).toBe(100)
  })

  it('getKeywordTrend returns keyword analytics', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(siteKeywordDateAnalytics).values([
      { siteId: 1, date: '2024-01-01', keyword: 'test query', clicks: 5, position: 300 },
      { siteId: 1, date: '2024-01-02', keyword: 'test query', clicks: 8, position: 250 },
    ])

    const result = await getKeywordTrend(db, 1, 'test query', '2024-01-01', '2024-01-02')
    expect(result).toHaveLength(2)
  })

  it('getTopKeywords aggregates by keyword', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(siteKeywordDateAnalytics).values([
      { siteId: 1, date: '2024-01-01', keyword: 'keyword1', clicks: 100 },
      { siteId: 1, date: '2024-01-02', keyword: 'keyword1', clicks: 100 },
      { siteId: 1, date: '2024-01-01', keyword: 'keyword2', clicks: 20 },
    ])

    const result = await getTopKeywords(db, 1, '2024-01-01', '2024-01-02')
    expect(result).toHaveLength(2)
    expect(result[0].keyword).toBe('keyword1')
    expect(result[0].total_clicks).toBe(200)
  })

  it('getCountryBreakdown aggregates by country', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(siteDateCountryAnalytics).values([
      { siteId: 1, date: '2024-01-01', country: 'USA', clicks: 500 },
      { siteId: 1, date: '2024-01-02', country: 'USA', clicks: 500 },
      { siteId: 1, date: '2024-01-01', country: 'GBR', clicks: 100 },
    ])

    const result = await getCountryBreakdown(db, 1, '2024-01-01', '2024-01-02')
    expect(result).toHaveLength(2)
    expect(result[0].country).toBe('USA')
    expect(result[0].total_clicks).toBe(1000)
  })

  it('getDeviceBreakdown aggregates by device', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(siteDateDeviceAnalytics).values([
      { siteId: 1, date: '2024-01-01', device: 'MOBILE', clicks: 300 },
      { siteId: 1, date: '2024-01-02', device: 'MOBILE', clicks: 300 },
      { siteId: 1, date: '2024-01-01', device: 'DESKTOP', clicks: 200 },
    ])

    const result = await getDeviceBreakdown(db, 1, '2024-01-01', '2024-01-02')
    expect(result).toHaveLength(2)
    expect(result[0].device).toBe('MOBILE')
    expect(result[0].total_clicks).toBe(600)
  })

  it('comparePeriods calculates diff', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sitePathDateAnalytics).values([
      { siteId: 1, date: '2024-01-01', path: '/test', clicks: 100, impressions: 1000 },
      { siteId: 1, date: '2024-01-15', path: '/test', clicks: 150, impressions: 1500 },
    ])

    const result = await comparePeriods(
      db,
      1,
      { start: '2024-01-15', end: '2024-01-15' },
      { start: '2024-01-01', end: '2024-01-01' },
    )

    // db0 drizzle returns raw column names
    expect(result.current?.total_clicks).toBe(150)
    expect(result.previous?.total_clicks).toBe(100)
    expect(result.diff.clicks).toBe(50)
  })

  it('pruneOldData removes old records', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sitePathDateAnalytics).values([
      { siteId: 1, date: '2023-01-01', path: '/old', clicks: 10 },
      { siteId: 1, date: '2024-01-01', path: '/new', clicks: 100 },
    ])

    await pruneOldData(db, '2023-12-31')

    const remaining = await getPageTrend(db, 1, '/old', '2023-01-01', '2023-12-31')
    expect(remaining).toHaveLength(0)

    const kept = await getPageTrend(db, 1, '/new', '2024-01-01', '2024-01-01')
    expect(kept).toHaveLength(1)
  })
})

describe('sync helpers', () => {
  it('getLastSyncedDate returns null when never synced', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sites).values({
      siteId: 1,
      property: 'sc-domain:example.com',
      domain: 'example.com',
    })

    const result = await getLastSyncedDate(db, 1)
    expect(result).toBeNull()
  })

  it('getLastSyncedDate returns formatted date after sync', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    await db.insert(sites).values({
      siteId: 1,
      property: 'sc-domain:example.com',
      domain: 'example.com',
    })

    await updateLastSynced(db, 1)
    const result = await getLastSyncedDate(db, 1)

    expect(result).toBeDefined()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/) // YYYY-MM-DD format
  })

  it('getLastSyncedDate returns correct date', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)

    // Insert with specific lastSynced timestamp (Jan 15, 2024)
    const timestamp = new Date('2024-01-15T12:00:00Z').getTime()
    await db.insert(sites).values({
      siteId: 1,
      property: 'sc-domain:example.com',
      domain: 'example.com',
      lastSynced: timestamp,
    })

    const result = await getLastSyncedDate(db, 1)
    expect(result).toBe('2024-01-15')
  })
})
