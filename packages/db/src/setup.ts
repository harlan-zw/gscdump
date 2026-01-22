import type { Database } from 'db0'

// All SQL statements for schema setup
// Using IF NOT EXISTS so it's safe to call multiple times
export const SCHEMA_STATEMENTS = [
  // Sites table (must be first - others reference it)
  `CREATE TABLE IF NOT EXISTS sites (
    site_id INTEGER PRIMARY KEY,
    property TEXT NOT NULL UNIQUE,
    domain TEXT,
    sitemaps TEXT,
    last_synced INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,

  // Site paths (URL tracking)
  `CREATE TABLE IF NOT EXISTS site_paths (
    site_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    last_seen INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, path),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_paths_path_idx ON site_paths(path)`,

  // Site date analytics (aggregate)
  `CREATE TABLE IF NOT EXISTS site_date_analytics (
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
    UNIQUE(site_id, date),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_date_analytics_date_idx ON site_date_analytics(date)`,

  // Site path date analytics (per-page)
  `CREATE TABLE IF NOT EXISTS site_path_date_analytics (
    site_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    path TEXT NOT NULL,
    clicks INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    ctr INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, date, path),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_path_date_analytics_date_idx ON site_path_date_analytics(date)`,
  `CREATE INDEX IF NOT EXISTS site_path_date_analytics_path_idx ON site_path_date_analytics(path)`,
  `CREATE INDEX IF NOT EXISTS site_path_date_analytics_site_date_idx ON site_path_date_analytics(site_id, date)`,
  `CREATE INDEX IF NOT EXISTS site_path_date_analytics_site_path_idx ON site_path_date_analytics(site_id, path)`,
  `CREATE INDEX IF NOT EXISTS site_path_date_analytics_clicks_idx ON site_path_date_analytics(clicks)`,

  // Site keyword date analytics
  `CREATE TABLE IF NOT EXISTS site_keyword_date_analytics (
    site_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    keyword TEXT NOT NULL,
    clicks INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    ctr INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, date, keyword),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_date_idx ON site_keyword_date_analytics(date)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_keyword_idx ON site_keyword_date_analytics(keyword)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_site_date_idx ON site_keyword_date_analytics(site_id, date)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_site_keyword_idx ON site_keyword_date_analytics(site_id, keyword)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_clicks_idx ON site_keyword_date_analytics(clicks)`,

  // Site keyword path date analytics (granular)
  `CREATE TABLE IF NOT EXISTS site_keyword_path_date_analytics (
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
    UNIQUE(site_id, date, keyword, path),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_date_idx ON site_keyword_path_date_analytics(date)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_keyword_idx ON site_keyword_path_date_analytics(keyword)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_path_idx ON site_keyword_path_date_analytics(path)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_site_date_idx ON site_keyword_path_date_analytics(site_id, date)`,
  `CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_site_path_idx ON site_keyword_path_date_analytics(site_id, path)`,

  // Site date country analytics
  `CREATE TABLE IF NOT EXISTS site_date_country_analytics (
    site_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    country TEXT NOT NULL,
    clicks INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    ctr INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, date, country),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_date_country_analytics_date_idx ON site_date_country_analytics(date)`,
  `CREATE INDEX IF NOT EXISTS site_date_country_analytics_country_idx ON site_date_country_analytics(country)`,
  `CREATE INDEX IF NOT EXISTS site_date_country_analytics_site_date_idx ON site_date_country_analytics(site_id, date)`,

  // Site date device analytics
  `CREATE TABLE IF NOT EXISTS site_date_device_analytics (
    site_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    device TEXT NOT NULL,
    clicks INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    ctr INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, date, device),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_date_device_analytics_date_idx ON site_date_device_analytics(date)`,
  `CREATE INDEX IF NOT EXISTS site_date_device_analytics_site_date_idx ON site_date_device_analytics(site_id, date)`,

  // Site date search appearance analytics
  `CREATE TABLE IF NOT EXISTS site_date_search_appearance_analytics (
    site_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    search_appearance TEXT NOT NULL,
    clicks INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    ctr INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, date, search_appearance),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_date_search_appearance_analytics_date_idx ON site_date_search_appearance_analytics(date)`,

  // Site path indexing status
  `CREATE TABLE IF NOT EXISTS site_path_indexing (
    site_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    is_indexed INTEGER,
    index_verdict TEXT,
    coverage_state TEXT,
    robots_txt_state TEXT,
    indexing_state TEXT,
    last_inspected INTEGER,
    last_index_requested INTEGER,
    last_index_request_type TEXT,
    last_index_request_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, path),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_path_indexing_path_idx ON site_path_indexing(path)`,
  `CREATE INDEX IF NOT EXISTS site_path_indexing_is_indexed_idx ON site_path_indexing(is_indexed)`,

  // Site sitemaps
  `CREATE TABLE IF NOT EXISTS site_sitemaps (
    site_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    type TEXT,
    last_submitted INTEGER,
    last_downloaded INTEGER,
    is_pending INTEGER,
    is_sitemaps_index INTEGER,
    warnings INTEGER,
    errors INTEGER,
    contents TEXT,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(site_id, path),
    FOREIGN KEY (site_id) REFERENCES sites(site_id)
  )`,
  `CREATE INDEX IF NOT EXISTS site_sitemaps_path_idx ON site_sitemaps(path)`,

  // Keywords metadata (enrichment)
  `CREATE TABLE IF NOT EXISTS keywords (
    keyword_id INTEGER PRIMARY KEY,
    keyword TEXT NOT NULL UNIQUE,
    competition_index INTEGER,
    competition TEXT,
    avg_monthly_searches INTEGER,
    last_synced INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,
]

/**
 * Complete SQL schema as a single string.
 * Useful for running migrations via D1 HTTP API or other raw SQL interfaces.
 */
export const SCHEMA_SQL = `${SCHEMA_STATEMENTS.join(';\n')};`

/**
 * Run schema setup using prepare().run() for D1 HTTP API compatibility.
 * Uses IF NOT EXISTS so it's safe to call multiple times.
 */
export async function setup(db0: Database): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) {
    await db0.prepare(sql).run()
  }
}

/**
 * @deprecated Use `setup()` instead - this uses exec() which isn't D1 HTTP API compatible
 */
export const setupSchema = setup
