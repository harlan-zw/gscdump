// 13-stage diagnostic classifier for a site's Search Console health.
// Each stage carries a severity, a one-line summary, and an evidence array
// the UI renders inline. The chooser walks issues → sitemaps → indexing
// metrics → page inventory in priority order.

export type SearchConsoleStageKey
  = | 'not_connected'
    | 'waiting_for_data'
    | 'weak_discovery'
    | 'discovery_backlog'
    | 'crawl_blocked'
    | 'indexability_blocked'
    | 'index_rejection'
    | 'partially_indexed'
    | 'indexed_invisible'
    | 'visible_not_clicked'
    | 'ranking_stalled'
    | 'declining_visibility'
    | 'healthy_growth_ready'

export type SearchConsoleStageSeverity = 'success' | 'error' | 'warning' | 'info' | 'neutral'

export interface SearchConsoleStageEvidence {
  label: string
  value: string
  source: 'connection' | 'indexing' | 'sitemap' | 'performance' | 'inspection' | 'canonical'
}

export interface SearchConsoleStage {
  key: SearchConsoleStageKey
  label: string
  severity: SearchConsoleStageSeverity
  summary: string
  primaryAction: string
  nextStage: SearchConsoleStageKey | null
  evidence: SearchConsoleStageEvidence[]
  sprintFindingTypes: string[]
}

export interface SearchConsoleStageIssue {
  type: string
  label: string
  severity?: 'error' | 'warning' | 'info'
  count: number
}

export interface SearchConsoleStageSummary {
  totalUrls: number
  indexed: number
  indexedPercent: number
  change7d?: number | null
  change28d?: number | null
}

export interface SearchConsoleStageSitemap {
  errors?: number | null
  warnings?: number | null
  lastError?: string | null
  urlCount?: number | null
}

export interface SearchConsoleStagePage {
  impressions: number
  clicks: number
  position?: number | null
}

export interface ClassifySearchConsoleStageInput {
  connected: boolean
  indexingStatus?: 'pending' | 'partial' | 'complete' | 'unknown' | string | null
  summary?: SearchConsoleStageSummary | null
  issues?: SearchConsoleStageIssue[] | null
  sitemaps?: SearchConsoleStageSitemap[] | null
  canonicalMismatchCount?: number | null
  pageInventory?: SearchConsoleStagePage[] | null
  ctrOutlierCount?: number | null
  pageMoverDropCount?: number | null
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en').format(Math.max(0, Math.round(value)))
}

function issueCount(issues: SearchConsoleStageIssue[] | null | undefined, ...types: string[]): number {
  if (!issues?.length)
    return 0
  const wanted = new Set(types)
  return issues.reduce((sum, issue) => sum + (wanted.has(issue.type) ? issue.count : 0), 0)
}

function totalSitemapErrors(sitemaps: SearchConsoleStageSitemap[] | null | undefined): number {
  return (sitemaps ?? []).reduce((sum, sitemap) => {
    return sum + (sitemap.errors ?? 0) + (sitemap.lastError ? 1 : 0)
  }, 0)
}

function stage(
  key: SearchConsoleStageKey,
  evidence: SearchConsoleStageEvidence[],
): SearchConsoleStage {
  const stages: Record<SearchConsoleStageKey, Omit<SearchConsoleStage, 'key' | 'evidence'>> = {
    not_connected: {
      label: 'Not connected',
      severity: 'neutral',
      summary: 'Search Console is not connected for this site yet.',
      primaryAction: 'Connect Google Search Console so we can read discovery, indexing, and performance data.',
      nextStage: 'waiting_for_data',
      sprintFindingTypes: [],
    },
    waiting_for_data: {
      label: 'Waiting for data',
      severity: 'info',
      summary: 'Search Console is connected, but there is not enough indexing data to diagnose the site yet.',
      primaryAction: 'Let the first sync finish, then make sure a sitemap is submitted.',
      nextStage: 'weak_discovery',
      sprintFindingTypes: [],
    },
    weak_discovery: {
      label: 'Weak discovery',
      severity: 'warning',
      summary: 'Google does not have a clean map of the pages you want indexed.',
      primaryAction: 'Submit a clean sitemap that contains only canonical, indexable 200 URLs.',
      nextStage: 'discovery_backlog',
      sprintFindingTypes: ['search-console-stage', 'sitemap-missing'],
    },
    discovery_backlog: {
      label: 'Discovery backlog',
      severity: 'warning',
      summary: 'Google knows these pages exist, but is not crawling them fast enough.',
      primaryAction: 'Add internal links from indexed pages and remove low-value URLs from the sitemap.',
      nextStage: 'crawl_blocked',
      sprintFindingTypes: ['search-console-stage'],
    },
    crawl_blocked: {
      label: 'Crawl blocked',
      severity: 'error',
      summary: 'Google is trying to access pages, but technical access problems are blocking progress.',
      primaryAction: 'Fix robots.txt blocks, server errors, broken URLs, and access failures before content work.',
      nextStage: 'indexability_blocked',
      sprintFindingTypes: ['search-console-stage', 'noindex-block'],
    },
    indexability_blocked: {
      label: 'Indexability blocked',
      severity: 'error',
      summary: 'Google can reach pages, but index directives or canonical signals are preventing clean indexing.',
      primaryAction: 'Remove accidental noindex directives and make canonical signals agree.',
      nextStage: 'index_rejection',
      sprintFindingTypes: ['search-console-stage', 'noindex-block', 'canonicalisation'],
    },
    index_rejection: {
      label: 'Index rejection',
      severity: 'warning',
      summary: 'Google is crawling pages but skipping too many of them from the index.',
      primaryAction: 'Improve or consolidate crawled-but-not-indexed pages before publishing more.',
      nextStage: 'partially_indexed',
      sprintFindingTypes: ['search-console-stage', 'pages-not-indexed'],
    },
    partially_indexed: {
      label: 'Partially indexed',
      severity: 'warning',
      summary: 'A meaningful share of the site is indexed, but coverage is still below a healthy level.',
      primaryAction: 'Work through the largest remaining indexing blocker first.',
      nextStage: 'indexed_invisible',
      sprintFindingTypes: ['search-console-stage', 'pages-not-indexed'],
    },
    indexed_invisible: {
      label: 'Indexed but invisible',
      severity: 'warning',
      summary: 'Pages are indexed, but too many are not earning impressions in Search.',
      primaryAction: 'Improve query targeting, titles, headings, internal links, and page depth.',
      nextStage: 'visible_not_clicked',
      sprintFindingTypes: ['search-console-stage'],
    },
    visible_not_clicked: {
      label: 'Visible but not clicked',
      severity: 'warning',
      summary: 'Google is showing your pages, but searchers are not clicking often enough.',
      primaryAction: 'Rewrite titles and descriptions for the queries already producing impressions.',
      nextStage: 'ranking_stalled',
      sprintFindingTypes: ['search-console-stage', 'ctr-outliers'],
    },
    ranking_stalled: {
      label: 'Ranking but stalled',
      severity: 'info',
      summary: 'The site has search visibility, but many pages are not yet ranking in useful positions.',
      primaryAction: 'Prioritise striking-distance pages, refresh content, and add internal links.',
      nextStage: 'healthy_growth_ready',
      sprintFindingTypes: ['striking-distance', 'internal-linking'],
    },
    declining_visibility: {
      label: 'Declining visibility',
      severity: 'error',
      summary: 'Search visibility is dropping compared with the previous period.',
      primaryAction: 'Review affected pages, recent releases, competitors, and SERP changes before expanding.',
      nextStage: 'healthy_growth_ready',
      sprintFindingTypes: ['search-console-stage', 'negative-movers'],
    },
    healthy_growth_ready: {
      label: 'Healthy, growth ready',
      severity: 'success',
      summary: 'Google can discover, index, and show the site. The next work is growth, not cleanup.',
      primaryAction: 'Use expansion work: striking-distance pages, content gaps, and authority building.',
      nextStage: null,
      sprintFindingTypes: ['striking-distance', 'competitor-content-gap'],
    },
  }

  return { key, evidence, ...stages[key] }
}

export function classifySearchConsoleStage(input: ClassifySearchConsoleStageInput): SearchConsoleStage {
  const issues = input.issues ?? []
  const summary = input.summary ?? null
  const sitemaps = input.sitemaps ?? []
  const totalUrls = summary?.totalUrls ?? 0
  const indexed = summary?.indexed ?? 0
  const indexedPercent = summary?.indexedPercent ?? 0
  const notIndexed = Math.max(0, totalUrls - indexed)

  if (!input.connected) {
    return stage('not_connected', [
      { label: 'Connection', value: 'Not connected', source: 'connection' },
    ])
  }

  if (input.indexingStatus === 'pending' || !summary || totalUrls === 0) {
    return stage('waiting_for_data', [
      { label: 'Indexing sync', value: input.indexingStatus === 'pending' ? 'Pending' : 'No URLs yet', source: 'indexing' },
    ])
  }

  const sitemapErrors = totalSitemapErrors(sitemaps)
  const sitemapUrlCount = sitemaps.reduce((sum, sitemap) => sum + (sitemap.urlCount ?? 0), 0)
  const unknown = issueCount(issues, 'unknown_to_google')
  const discovered = issueCount(issues, 'discovered_not_indexed')
  const crawled = issueCount(issues, 'crawled_not_indexed')
  const crawlBlocks = issueCount(issues, 'blocked_robots', 'server_error', 'not_found', 'soft_404', 'access_denied', 'forbidden')
  const indexBlocks = issueCount(issues, 'noindex', 'canonical_mismatch')
  const canonicalMismatches = input.canonicalMismatchCount ?? issueCount(issues, 'canonical_mismatch')
  const zeroImpressionPages = (input.pageInventory ?? []).filter(page => page.impressions === 0).length
  const visibleNoClickPages = (input.pageInventory ?? []).filter(page => page.impressions >= 50 && page.clicks === 0).length
  const poorPositionPages = (input.pageInventory ?? []).filter(page => page.impressions >= 50 && (page.position ?? 0) > 20).length
  const pageMoverDropCount = input.pageMoverDropCount ?? 0
  const ctrOutlierCount = input.ctrOutlierCount ?? 0

  if (summary.change7d != null && summary.change7d <= -5) {
    return stage('declining_visibility', [
      { label: 'Index rate change', value: `${summary.change7d.toFixed(1)}% in 7 days`, source: 'indexing' },
      { label: 'Indexed pages', value: `${formatCount(indexed)} of ${formatCount(totalUrls)}`, source: 'indexing' },
    ])
  }

  if (pageMoverDropCount > 0) {
    return stage('declining_visibility', [
      { label: 'Falling pages', value: formatCount(pageMoverDropCount), source: 'performance' },
    ])
  }

  if (sitemaps.length === 0 || sitemapUrlCount === 0 || sitemapErrors > 0 || unknown > Math.max(5, totalUrls * 0.1)) {
    return stage('weak_discovery', [
      { label: 'Sitemaps', value: sitemaps.length === 0 ? 'None registered' : `${formatCount(sitemapErrors)} errors`, source: 'sitemap' },
      ...(unknown > 0 ? [{ label: 'Unknown URLs', value: formatCount(unknown), source: 'indexing' as const }] : []),
    ])
  }

  if (discovered > Math.max(10, totalUrls * 0.15)) {
    return stage('discovery_backlog', [
      { label: 'Discovered, not crawled', value: formatCount(discovered), source: 'indexing' },
      { label: 'Indexed pages', value: `${indexedPercent.toFixed(1)}%`, source: 'indexing' },
    ])
  }

  if (crawlBlocks > Math.max(5, totalUrls * 0.05)) {
    return stage('crawl_blocked', [
      { label: 'Crawl blockers', value: formatCount(crawlBlocks), source: 'indexing' },
      { label: 'Indexed pages', value: `${formatCount(indexed)} of ${formatCount(totalUrls)}`, source: 'indexing' },
    ])
  }

  if (indexBlocks > Math.max(5, totalUrls * 0.05) || canonicalMismatches > Math.max(5, totalUrls * 0.05)) {
    return stage('indexability_blocked', [
      ...(indexBlocks > 0 ? [{ label: 'Index signal blockers', value: formatCount(indexBlocks), source: 'indexing' as const }] : []),
      ...(canonicalMismatches > 0 ? [{ label: 'Canonical mismatches', value: formatCount(canonicalMismatches), source: 'canonical' as const }] : []),
    ])
  }

  if (crawled > Math.max(10, totalUrls * 0.15)) {
    return stage('index_rejection', [
      { label: 'Crawled, not indexed', value: formatCount(crawled), source: 'indexing' },
      { label: 'Not indexed', value: formatCount(notIndexed), source: 'indexing' },
    ])
  }

  if (indexedPercent < 80) {
    return stage('partially_indexed', [
      { label: 'Indexed', value: `${indexedPercent.toFixed(1)}%`, source: 'indexing' },
      { label: 'Not indexed', value: formatCount(notIndexed), source: 'indexing' },
    ])
  }

  if (zeroImpressionPages >= Math.max(1, (input.pageInventory?.length ?? 0) * 0.25)) {
    return stage('indexed_invisible', [
      { label: 'No-impression pages', value: formatCount(zeroImpressionPages), source: 'performance' },
    ])
  }

  if (ctrOutlierCount > 0 || visibleNoClickPages >= Math.max(1, (input.pageInventory?.length ?? 0) * 0.25)) {
    return stage('visible_not_clicked', [
      ...(ctrOutlierCount > 0 ? [{ label: 'CTR outliers', value: formatCount(ctrOutlierCount), source: 'performance' as const }] : []),
      ...(visibleNoClickPages > 0 ? [{ label: 'Visible, no clicks', value: formatCount(visibleNoClickPages), source: 'performance' as const }] : []),
    ])
  }

  if (poorPositionPages >= Math.max(1, (input.pageInventory?.length ?? 0) * 0.25)) {
    return stage('ranking_stalled', [
      { label: 'Low-ranking visible pages', value: formatCount(poorPositionPages), source: 'performance' },
    ])
  }

  return stage('healthy_growth_ready', [
    { label: 'Indexed', value: `${indexedPercent.toFixed(1)}%`, source: 'indexing' },
    { label: 'Critical blockers', value: '0', source: 'indexing' },
  ])
}
