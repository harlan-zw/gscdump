// Predefined issue filters for indexing status.
// Each maps to a SQL condition against a `url_indexing_status`-shaped table.
// Consumers compose these into queries against their own storage.

export const INDEXING_ISSUE_FILTERS = {
  canonical_mismatch: `user_canonical IS NOT NULL AND google_canonical IS NOT NULL AND user_canonical != google_canonical`,
  stale_crawl: `last_crawl_time < datetime('now', '-30 days')`,
  very_stale_crawl: `last_crawl_time < datetime('now', '-60 days')`,
  not_indexed: `verdict IN ('FAIL', 'PARTIAL', 'NEUTRAL')`,
  unknown_to_google: `coverage_state = 'URL is unknown to Google'`,
  crawled_not_indexed: `coverage_state LIKE '%Crawled%not indexed%' OR coverage_state LIKE '%Discovered%not indexed%'`,
  not_found: `page_fetch_state = 'NOT_FOUND' OR coverage_state = 'Not found (404)'`,
  soft_404: `page_fetch_state = 'SOFT_404'`,
  server_error: `page_fetch_state = 'SERVER_ERROR'`,
  blocked_robots: `robots_txt_state = 'DISALLOWED'`,
  noindex: `indexing_state LIKE '%noindex%' OR coverage_state LIKE '%noindex%'`,
  redirect: `coverage_state = 'Page with redirect'`,
  fragment_url: `url LIKE '%#%'`,
  mobile_fail: `mobile_verdict IN ('FAIL', 'PARTIAL')`,
  rich_results_fail: `rich_results_verdict = 'FAIL'`,
  rich_results_warning: `rich_results_verdict = 'PARTIAL'`,
  rich_results_pass: `rich_results_verdict = 'PASS'`,
} as const

export type IndexingIssueType = keyof typeof INDEXING_ISSUE_FILTERS

export const INDEXING_ISSUE_LABELS: Record<IndexingIssueType, string> = {
  canonical_mismatch: 'Canonical mismatch',
  stale_crawl: 'Not crawled in 30+ days',
  very_stale_crawl: 'Not crawled in 60+ days',
  not_indexed: 'Not indexed',
  unknown_to_google: 'Unknown to Google',
  crawled_not_indexed: 'Crawled but not indexed',
  not_found: '404 Not Found',
  soft_404: 'Soft 404',
  server_error: 'Server error',
  blocked_robots: 'Blocked by robots.txt',
  noindex: 'Noindex tag',
  redirect: 'Redirect',
  fragment_url: 'Fragment URL (#)',
  mobile_fail: 'Mobile usability issues',
  rich_results_fail: 'Rich results errors',
  rich_results_warning: 'Rich results warnings',
  rich_results_pass: 'Has rich results',
}

export const INDEXING_ISSUE_SEVERITY: Record<IndexingIssueType, 'error' | 'warning' | 'info'> = {
  canonical_mismatch: 'warning',
  stale_crawl: 'info',
  very_stale_crawl: 'warning',
  not_indexed: 'error',
  unknown_to_google: 'warning',
  crawled_not_indexed: 'error',
  not_found: 'error',
  soft_404: 'error',
  server_error: 'error',
  blocked_robots: 'warning',
  noindex: 'info',
  redirect: 'info',
  fragment_url: 'warning',
  mobile_fail: 'warning',
  rich_results_fail: 'error',
  rich_results_warning: 'warning',
  rich_results_pass: 'info',
}
