import type { Database } from 'db0'

// Creates all tables for the GSC CLI database
// Uses IF NOT EXISTS so it's safe to call multiple times
export async function setupSchema(db0: Database): Promise<void> {
  // Sites table (must be first - others reference it)
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

  // Site paths (URL tracking)
  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_paths (
      site_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      last_seen INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(site_id, path),
      FOREIGN KEY (site_id) REFERENCES sites(site_id)
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_paths_path_idx ON site_paths(path)`)

  // Site date analytics (aggregate)
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
      UNIQUE(site_id, date),
      FOREIGN KEY (site_id) REFERENCES sites(site_id)
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_date_analytics_date_idx ON site_date_analytics(date)`)

  // Site path date analytics (per-page)
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
      UNIQUE(site_id, date, path),
      FOREIGN KEY (site_id) REFERENCES sites(site_id)
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_path_date_analytics_date_idx ON site_path_date_analytics(date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_path_date_analytics_path_idx ON site_path_date_analytics(path)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_path_date_analytics_site_date_idx ON site_path_date_analytics(site_id, date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_path_date_analytics_site_path_idx ON site_path_date_analytics(site_id, path)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_path_date_analytics_clicks_idx ON site_path_date_analytics(clicks)`)

  // Site keyword date analytics
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
      UNIQUE(site_id, date, keyword),
      FOREIGN KEY (site_id) REFERENCES sites(site_id)
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_date_idx ON site_keyword_date_analytics(date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_keyword_idx ON site_keyword_date_analytics(keyword)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_site_date_idx ON site_keyword_date_analytics(site_id, date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_site_keyword_idx ON site_keyword_date_analytics(site_id, keyword)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_date_analytics_clicks_idx ON site_keyword_date_analytics(clicks)`)

  // Site keyword path date analytics (granular)
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
      UNIQUE(site_id, date, keyword, path),
      FOREIGN KEY (site_id) REFERENCES sites(site_id)
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_date_idx ON site_keyword_path_date_analytics(date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_keyword_idx ON site_keyword_path_date_analytics(keyword)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_path_idx ON site_keyword_path_date_analytics(path)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_site_date_idx ON site_keyword_path_date_analytics(site_id, date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_keyword_path_date_analytics_site_path_idx ON site_keyword_path_date_analytics(site_id, path)`)

  // Site date country analytics
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
      UNIQUE(site_id, date, country),
      FOREIGN KEY (site_id) REFERENCES sites(site_id)
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_date_country_analytics_date_idx ON site_date_country_analytics(date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_date_country_analytics_country_idx ON site_date_country_analytics(country)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_date_country_analytics_site_date_idx ON site_date_country_analytics(site_id, date)`)

  // Site date device analytics
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
      UNIQUE(site_id, date, device),
      FOREIGN KEY (site_id) REFERENCES sites(site_id)
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_date_device_analytics_date_idx ON site_date_device_analytics(date)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_date_device_analytics_site_date_idx ON site_date_device_analytics(site_id, date)`)

  // Site date search appearance analytics
  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_date_search_appearance_analytics (
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
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_date_search_appearance_analytics_date_idx ON site_date_search_appearance_analytics(date)`)

  // Site path indexing status
  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_path_indexing (
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
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_path_indexing_path_idx ON site_path_indexing(path)`)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_path_indexing_is_indexed_idx ON site_path_indexing(is_indexed)`)

  // Site sitemaps
  await db0.exec(`
    CREATE TABLE IF NOT EXISTS site_sitemaps (
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
    )
  `)
  await db0.exec(`CREATE INDEX IF NOT EXISTS site_sitemaps_path_idx ON site_sitemaps(path)`)

  // Keywords metadata (enrichment)
  await db0.exec(`
    CREATE TABLE IF NOT EXISTS keywords (
      keyword_id INTEGER PRIMARY KEY,
      keyword TEXT NOT NULL UNIQUE,
      competition_index INTEGER,
      competition TEXT,
      avg_monthly_searches INTEGER,
      last_synced INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at INTEGER NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `)
}
