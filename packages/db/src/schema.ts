import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

const timestamps = {
  createdAt: integer('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: integer('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
}

const gscMetrics = {
  clicks: integer('clicks').default(0),
  impressions: integer('impressions').default(0),
  ctr: integer('ctr').default(0), // stored as ctr * 10000 for precision
  position: integer('position').default(0), // stored as position * 100 for precision
}

// GSC properties (sites)
export const sites = sqliteTable('sites', {
  siteId: integer('site_id').notNull().primaryKey(),
  property: text('property').notNull().unique(), // sc-domain:example.com or https://example.com/
  domain: text('domain'), // extracted domain for easier querying
  sitemaps: text('sitemaps', { mode: 'json' }).$type<string[]>(),
  lastSynced: integer('last_synced'),
  ...timestamps,
})

export type SiteInsert = typeof sites.$inferInsert
export type SiteSelect = typeof sites.$inferSelect

// URLs/pages within a site
export const sitePaths = sqliteTable('site_paths', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  path: text('path').notNull(),
  lastSeen: integer('last_seen'),
  ...timestamps,
}, t => ({
  pathIdx: index('site_paths_path_idx').on(t.path),
  unq: unique().on(t.siteId, t.path),
}))

export type SitePathInsert = typeof sitePaths.$inferInsert
export type SitePathSelect = typeof sitePaths.$inferSelect

// Daily site-level analytics
export const siteDateAnalytics = sqliteTable('site_date_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(), // YYYY-MM-DD
  ...gscMetrics,
  // device breakdown
  mobileClicks: integer('mobile_clicks'),
  mobileImpressions: integer('mobile_impressions'),
  desktopClicks: integer('desktop_clicks'),
  desktopImpressions: integer('desktop_impressions'),
  tabletClicks: integer('tablet_clicks'),
  tabletImpressions: integer('tablet_impressions'),
  // counts
  keywords: integer('keywords'),
  pages: integer('pages'),
  ...timestamps,
}, t => ({
  dateIdx: index('site_date_analytics_date_idx').on(t.date),
  unq: unique().on(t.siteId, t.date),
}))

export type SiteDateAnalyticsInsert = typeof siteDateAnalytics.$inferInsert
export type SiteDateAnalyticsSelect = typeof siteDateAnalytics.$inferSelect

// Daily page-level analytics
export const sitePathDateAnalytics = sqliteTable('site_path_date_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(),
  path: text('path').notNull(),
  ...gscMetrics,
  ...timestamps,
}, t => ({
  dateIdx: index('site_path_date_analytics_date_idx').on(t.date),
  pathIdx: index('site_path_date_analytics_path_idx').on(t.path),
  // Composite indexes for common query patterns
  siteDateIdx: index('site_path_date_analytics_site_date_idx').on(t.siteId, t.date),
  sitePathIdx: index('site_path_date_analytics_site_path_idx').on(t.siteId, t.path),
  clicksIdx: index('site_path_date_analytics_clicks_idx').on(t.clicks),
  unq: unique().on(t.siteId, t.date, t.path),
}))

export type SitePathDateAnalyticsInsert = typeof sitePathDateAnalytics.$inferInsert
export type SitePathDateAnalyticsSelect = typeof sitePathDateAnalytics.$inferSelect

// Daily keyword analytics
export const siteKeywordDateAnalytics = sqliteTable('site_keyword_date_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(),
  keyword: text('keyword').notNull(),
  ...gscMetrics,
  ...timestamps,
}, t => ({
  dateIdx: index('site_keyword_date_analytics_date_idx').on(t.date),
  keywordIdx: index('site_keyword_date_analytics_keyword_idx').on(t.keyword),
  // Composite indexes for common query patterns
  siteDateIdx: index('site_keyword_date_analytics_site_date_idx').on(t.siteId, t.date),
  siteKeywordIdx: index('site_keyword_date_analytics_site_keyword_idx').on(t.siteId, t.keyword),
  clicksIdx: index('site_keyword_date_analytics_clicks_idx').on(t.clicks),
  unq: unique().on(t.siteId, t.date, t.keyword),
}))

export type SiteKeywordDateAnalyticsInsert = typeof siteKeywordDateAnalytics.$inferInsert
export type SiteKeywordDateAnalyticsSelect = typeof siteKeywordDateAnalytics.$inferSelect

// Daily keyword-per-page analytics (most granular - enables "which keywords drive traffic to this page")
export const siteKeywordPathDateAnalytics = sqliteTable('site_keyword_path_date_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(),
  keyword: text('keyword').notNull(),
  path: text('path').notNull(),
  ...gscMetrics,
  ...timestamps,
}, t => ({
  dateIdx: index('site_keyword_path_date_analytics_date_idx').on(t.date),
  keywordIdx: index('site_keyword_path_date_analytics_keyword_idx').on(t.keyword),
  pathIdx: index('site_keyword_path_date_analytics_path_idx').on(t.path),
  siteDateIdx: index('site_keyword_path_date_analytics_site_date_idx').on(t.siteId, t.date),
  sitePathIdx: index('site_keyword_path_date_analytics_site_path_idx').on(t.siteId, t.path),
  unq: unique().on(t.siteId, t.date, t.keyword, t.path),
}))

export type SiteKeywordPathDateAnalyticsInsert = typeof siteKeywordPathDateAnalytics.$inferInsert
export type SiteKeywordPathDateAnalyticsSelect = typeof siteKeywordPathDateAnalytics.$inferSelect

// Daily country analytics
export const siteDateCountryAnalytics = sqliteTable('site_date_country_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(),
  country: text('country').notNull(), // ISO 3166-1 alpha-3
  ...gscMetrics,
  ...timestamps,
}, t => ({
  dateIdx: index('site_date_country_analytics_date_idx').on(t.date),
  countryIdx: index('site_date_country_analytics_country_idx').on(t.country),
  siteDateIdx: index('site_date_country_analytics_site_date_idx').on(t.siteId, t.date),
  unq: unique().on(t.siteId, t.date, t.country),
}))

export type SiteDateCountryAnalyticsInsert = typeof siteDateCountryAnalytics.$inferInsert
export type SiteDateCountryAnalyticsSelect = typeof siteDateCountryAnalytics.$inferSelect

// Daily device analytics
export const siteDateDeviceAnalytics = sqliteTable('site_date_device_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(),
  device: text('device').notNull(), // MOBILE, DESKTOP, TABLET
  ...gscMetrics,
  ...timestamps,
}, t => ({
  dateIdx: index('site_date_device_analytics_date_idx').on(t.date),
  siteDateIdx: index('site_date_device_analytics_site_date_idx').on(t.siteId, t.date),
  unq: unique().on(t.siteId, t.date, t.device),
}))

export type SiteDateDeviceAnalyticsInsert = typeof siteDateDeviceAnalytics.$inferInsert
export type SiteDateDeviceAnalyticsSelect = typeof siteDateDeviceAnalytics.$inferSelect

// Keyword metadata (optional enrichment)
export const keywords = sqliteTable('keywords', {
  keywordId: integer('keyword_id').notNull().primaryKey(),
  keyword: text('keyword').notNull().unique(),
  // external data enrichment (Google Ads, etc)
  competitionIndex: integer('competition_index'),
  competition: text('competition'), // LOW, MEDIUM, HIGH
  avgMonthlySearches: integer('avg_monthly_searches'),
  lastSynced: integer('last_synced'),
  ...timestamps,
})

export type KeywordInsert = typeof keywords.$inferInsert
export type KeywordSelect = typeof keywords.$inferSelect

// URL indexing status tracking
export const sitePathIndexing = sqliteTable('site_path_indexing', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  path: text('path').notNull(),
  // Inspection API results
  isIndexed: integer('is_indexed', { mode: 'boolean' }),
  indexVerdict: text('index_verdict'), // PASS, FAIL, NEUTRAL, etc
  coverageState: text('coverage_state'), // Indexed, Crawled - currently not indexed, etc
  robotsTxtState: text('robots_txt_state'),
  indexingState: text('indexing_state'),
  lastInspected: integer('last_inspected'),
  // Indexing API requests
  lastIndexRequested: integer('last_index_requested'),
  lastIndexRequestType: text('last_index_request_type'), // URL_UPDATED, URL_DELETED
  lastIndexRequestError: text('last_index_request_error'),
  ...timestamps,
}, t => ({
  pathIdx: index('site_path_indexing_path_idx').on(t.path),
  isIndexedIdx: index('site_path_indexing_is_indexed_idx').on(t.isIndexed),
  unq: unique().on(t.siteId, t.path),
}))

export type SitePathIndexingInsert = typeof sitePathIndexing.$inferInsert
export type SitePathIndexingSelect = typeof sitePathIndexing.$inferSelect

// Daily search appearance analytics (AMP, rich results, etc.)
export const siteDateSearchAppearanceAnalytics = sqliteTable('site_date_search_appearance_analytics', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  date: text('date').notNull(),
  searchAppearance: text('search_appearance').notNull(), // AMP_ARTICLE, RICH_RESULT, etc.
  ...gscMetrics,
  ...timestamps,
}, t => ({
  dateIdx: index('site_date_search_appearance_analytics_date_idx').on(t.date),
  unq: unique().on(t.siteId, t.date, t.searchAppearance),
}))

export type SiteDateSearchAppearanceAnalyticsInsert = typeof siteDateSearchAppearanceAnalytics.$inferInsert
export type SiteDateSearchAppearanceAnalyticsSelect = typeof siteDateSearchAppearanceAnalytics.$inferSelect

// Sitemap details (replaces JSON in sites table)
export const siteSitemaps = sqliteTable('site_sitemaps', {
  siteId: integer('site_id').notNull().references(() => sites.siteId),
  path: text('path').notNull(), // sitemap URL
  type: text('type'), // sitemap, sitemapIndex
  lastSubmitted: integer('last_submitted'),
  lastDownloaded: integer('last_downloaded'),
  isPending: integer('is_pending', { mode: 'boolean' }),
  isSitemapsIndex: integer('is_sitemaps_index', { mode: 'boolean' }),
  warnings: integer('warnings'), // number of warnings
  errors: integer('errors'), // number of errors
  contents: text('contents', { mode: 'json' }).$type<{ type: string, submitted: string, indexed: string }[]>(),
  ...timestamps,
}, t => ({
  pathIdx: index('site_sitemaps_path_idx').on(t.path),
  unq: unique().on(t.siteId, t.path),
}))

export type SiteSitemapInsert = typeof siteSitemaps.$inferInsert
export type SiteSitemapSelect = typeof siteSitemaps.$inferSelect
