// Builds `search.google.com/search-console?...` deep-links for a site +
// optional page / query. Portable across consumers — no layer state, pure
// URL string concat.

export interface GscConsoleUrlOpts {
  /** The GSC property — either `sc-domain:example.com` or a URL-prefix. */
  siteLabel: string
  /** Optional page to open Performance drilldown for. */
  page?: string
  /** Optional query filter. */
  query?: string
  /** Resource: `performance`, `url-inspection`, `sitemaps`, … */
  resource?: 'performance' | 'url-inspection' | 'sitemaps' | 'index'
}

export function gscConsoleUrl(opts: GscConsoleUrlOpts): string {
  const base = 'https://search.google.com/search-console'
  const resource = opts.resource ?? 'performance'
  const params = new URLSearchParams()
  // Default `sc-domain:` prefix when caller passes a bare hostname.
  const siteLabel = /^(?:https?:|sc-domain:)/.test(opts.siteLabel)
    ? opts.siteLabel
    : `sc-domain:${opts.siteLabel}`
  params.set('resource_id', siteLabel)
  if (resource === 'url-inspection') {
    // Inspect tool expects the absolute URL under `id`, not Performance's
    // `page=*<url>` wildcard filter.
    if (opts.page)
      params.set('id', opts.page)
  }
  else {
    if (opts.page)
      params.set('page', `*${opts.page}`)
    if (opts.query)
      params.set('query', `*${opts.query}`)
  }
  const path = resource === 'performance'
    ? '/performance/search-analytics'
    : resource === 'url-inspection'
      ? '/inspect'
      : resource === 'sitemaps'
        ? '/sitemaps'
        : '/index'
  return `${base}${path}?${params.toString()}`
}
