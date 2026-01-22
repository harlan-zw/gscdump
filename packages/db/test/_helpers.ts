import type { Database } from 'db0'
import type { GoogleSearchConsoleDatabase } from '../src/connector'
import { createDatabase } from 'db0'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { drizzle } from 'db0/integrations/drizzle'
import {
  siteDateCountryAnalytics,
  siteDateDeviceAnalytics,
  siteKeywordDateAnalytics,
  siteKeywordPathDateAnalytics,
  sitePathDateAnalytics,
  sites,
} from '../src/schema'

export function createTestDb(): { db0: Database, db: GoogleSearchConsoleDatabase } {
  const db0 = createDatabase(betterSqlite3({ name: ':memory:' }))
  const db = drizzle(db0) as GoogleSearchConsoleDatabase
  return { db0, db }
}

export async function setupSchema(db0: Database): Promise<void> {
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
    CREATE TABLE IF NOT EXISTS site_keyword_path_date_analytics (
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      keyword TEXT NOT NULL,
      path TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(site_id, date, keyword, path)
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

export async function seedTestData(db: GoogleSearchConsoleDatabase): Promise<void> {
  // Site
  await db.insert(sites).values({
    siteId: 1,
    property: 'sc-domain:example.com',
    domain: 'example.com',
  })

  // Page analytics - current period (Jan 10-12)
  await db.insert(sitePathDateAnalytics).values([
    { siteId: 1, date: '2024-01-10', path: '/page1', clicks: 100, impressions: 1000, ctr: 1000, position: 500 },
    { siteId: 1, date: '2024-01-11', path: '/page1', clicks: 120, impressions: 1100, ctr: 1090, position: 480 },
    { siteId: 1, date: '2024-01-12', path: '/page1', clicks: 110, impressions: 1050, ctr: 1047, position: 490 },
    { siteId: 1, date: '2024-01-10', path: '/page2', clicks: 50, impressions: 500, ctr: 1000, position: 800 },
    { siteId: 1, date: '2024-01-11', path: '/page2', clicks: 55, impressions: 550, ctr: 1000, position: 750 },
  ])

  // Page analytics - previous period (Jan 1-3)
  await db.insert(sitePathDateAnalytics).values([
    { siteId: 1, date: '2024-01-01', path: '/page1', clicks: 80, impressions: 800, ctr: 1000, position: 600 },
    { siteId: 1, date: '2024-01-02', path: '/page1', clicks: 85, impressions: 850, ctr: 1000, position: 580 },
    { siteId: 1, date: '2024-01-03', path: '/page1', clicks: 90, impressions: 900, ctr: 1000, position: 550 },
    { siteId: 1, date: '2024-01-01', path: '/lost-page', clicks: 30, impressions: 300, ctr: 1000, position: 1000 },
  ])

  // Keyword analytics
  await db.insert(siteKeywordDateAnalytics).values([
    { siteId: 1, date: '2024-01-10', keyword: 'test keyword', clicks: 50, impressions: 500, ctr: 1000, position: 300 },
    { siteId: 1, date: '2024-01-11', keyword: 'test keyword', clicks: 60, impressions: 600, ctr: 1000, position: 280 },
    { siteId: 1, date: '2024-01-10', keyword: 'another keyword', clicks: 20, impressions: 200, ctr: 1000, position: 500 },
    // Previous period
    { siteId: 1, date: '2024-01-01', keyword: 'test keyword', clicks: 40, impressions: 400, ctr: 1000, position: 350 },
    { siteId: 1, date: '2024-01-01', keyword: 'lost keyword', clicks: 15, impressions: 150, ctr: 1000, position: 700 },
  ])

  // Keyword-path analytics (granular)
  await db.insert(siteKeywordPathDateAnalytics).values([
    { siteId: 1, date: '2024-01-10', keyword: 'test keyword', path: '/page1', clicks: 40, impressions: 400, ctr: 1000, position: 300 },
    { siteId: 1, date: '2024-01-10', keyword: 'test keyword', path: '/page2', clicks: 10, impressions: 100, ctr: 1000, position: 500 },
    { siteId: 1, date: '2024-01-11', keyword: 'test keyword', path: '/page1', clicks: 50, impressions: 500, ctr: 1000, position: 280 },
    { siteId: 1, date: '2024-01-10', keyword: 'another keyword', path: '/page1', clicks: 20, impressions: 200, ctr: 1000, position: 500 },
  ])

  // Country analytics
  await db.insert(siteDateCountryAnalytics).values([
    { siteId: 1, date: '2024-01-10', country: 'usa', clicks: 200, impressions: 2000, ctr: 1000, position: 400 },
    { siteId: 1, date: '2024-01-11', country: 'usa', clicks: 220, impressions: 2200, ctr: 1000, position: 380 },
    { siteId: 1, date: '2024-01-10', country: 'gbr', clicks: 50, impressions: 500, ctr: 1000, position: 600 },
    // Previous
    { siteId: 1, date: '2024-01-01', country: 'usa', clicks: 180, impressions: 1800, ctr: 1000, position: 450 },
  ])

  // Device analytics
  await db.insert(siteDateDeviceAnalytics).values([
    { siteId: 1, date: '2024-01-10', device: 'MOBILE', clicks: 150, impressions: 1500, ctr: 1000, position: 500 },
    { siteId: 1, date: '2024-01-11', device: 'MOBILE', clicks: 160, impressions: 1600, ctr: 1000, position: 480 },
    { siteId: 1, date: '2024-01-10', device: 'DESKTOP', clicks: 100, impressions: 1000, ctr: 1000, position: 400 },
    // Previous
    { siteId: 1, date: '2024-01-01', device: 'MOBILE', clicks: 120, impressions: 1200, ctr: 1000, position: 550 },
  ])
}
