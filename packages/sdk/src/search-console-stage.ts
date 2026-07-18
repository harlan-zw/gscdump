import { countSearchConsoleIssues, formatSearchConsoleCount } from './search-console-signals'
import { siteTypeBaseline } from './site-baseline'

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

/**
 * Trajectory + maturity signals (v2). These are first-class axes: a site that
 * is growing over the robust 90-day window is told to keep expanding, never to
 * "fix indexing", regardless of coverage%. Percent fields are whole numbers
 * (e.g. 42.6 for +42.6%); `positionDelta90d` is current − prior (negative =
 * rank improved). Window contract: callers MUST drop the trailing ~3 GSC lag
 * days before computing these, and the 7-day window is intentionally absent —
 * it is too lag-contaminated to classify on.
 */
export interface SearchConsoleStageTrajectory {
  clicksPct90d?: number | null
  impressionsPct90d?: number | null
  positionDelta90d?: number | null
  clicksPct28d?: number | null
  /**
   * Absolute clicks in the PRIOR 28-day window — the baseline a decline would
   * be measured against. Gates decline detection so a percentage crash on
   * trivial traffic (8 → 2 clicks) is not mistaken for a real loss.
   */
  clicksPrior28d?: number | null
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
  /** v2 trajectory axis — when present, drives the growth override + decline detection. */
  trajectory?: SearchConsoleStageTrajectory | null
  /** v2 maturity axis — impressions over the trailing 28 days. Gates whether coverage% is even meaningful. */
  impressions28d?: number | null
  /**
   * v2 on-page technical faults from the crawl audit (broken links/images,
   * server errors, access failures) — counted as hard blockers alongside GSC
   * crawl reasons. Excludes intentional noindex.
   */
  crawlAuditBlockerCount?: number | null
  /** v2 authority signal — open recoverable broken backlinks (expansion lever, not a defect). */
  recoverableBacklinkCount?: number | null
  /** v2 authority signal — cross-competitor content-gap topics (expansion readiness). */
  competitorGapCount?: number | null
  /**
   * v2 site purpose (AI profile `type`). Benchmarks the verdict against intent:
   * informational types (docs/blog/portfolio) earn structurally low CTR, so the
   * visible-not-clicked bar is raised for them. Unknown/null → `other`.
   */
  siteType?: string | null
}

function totalSitemapErrors(sitemaps: SearchConsoleStageSitemap[] | null | undefined): number {
  return (sitemaps ?? []).reduce((sum, sitemap) => {
    return sum + (sitemap.errors ?? 0) + (sitemap.lastError ? 1 : 0)
  }, 0)
}

function signedPct1(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

const SEARCH_CONSOLE_STAGES: Record<SearchConsoleStageKey, Omit<SearchConsoleStage, 'key' | 'evidence'>> = {
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
    label: 'Healthy',
    severity: 'success',
    summary: 'Google can discover, index, and show your pages.',
    primaryAction: 'Push striking-distance pages (positions 11 to 20) and close content gaps to grow impressions.',
    nextStage: null,
    sprintFindingTypes: ['striking-distance', 'competitor-content-gap'],
  },
}

function stage(
  key: SearchConsoleStageKey,
  evidence: SearchConsoleStageEvidence[],
): SearchConsoleStage {
  const definition = SEARCH_CONSOLE_STAGES[key]
  return {
    key,
    evidence,
    ...definition,
    // Preserve the old per-result array ownership while allocating only the
    // selected definition instead of rebuilding all thirteen stage objects.
    sprintFindingTypes: [...definition.sprintFindingTypes],
  }
}

// v2 thresholds, derived from a 12-site live audit (docs/search-console-stage-v2-audit.md).
// MATURITY: the 5 sites >20k impressions/28d were all growing with coverage 52–100%,
// so coverage% stops predicting health above this line; the next site down sits at ~5k.
const ESTABLISHED_IMPRESSIONS_28D = 20000
// Below this, traffic is too thin to diagnose coverage at all (gscdump 17, mdream 170, skilld 146).
const NASCENT_IMPRESSIONS_28D = 1000
// GROWTH: every healthy exemplar cleared +10% clicks/90d (+25/+43/+100/+191/+28).
const GROWTH_CLICKS_PCT_90D = 10
const GROWTH_IMPRESSIONS_PCT_90D = 20
// DECLINE: require BOTH windows down to filter lag/noise (largemirage −44/90d, requestindexing −48/90d).
const DECLINE_CLICKS_PCT = -10
// ...and require a meaningful baseline to decline FROM. Prior-28d clicks cleanly
// split real losses (requestindexing 117, largemirage 156) from tiny-traffic
// noise (harlanzw 8, zhead 22) where a % crash is statistically meaningless.
const MIN_DECLINE_PRIOR_CLICKS = 50

/**
 * v2 classifier. Trajectory and maturity are first-class axes that run BEFORE
 * the coverage/discovery rungs, so a growing site is told to keep expanding —
 * never to "fix indexing". Reuses the existing stage-key enum (growth →
 * `healthy_growth_ready`, nascent → `waiting_for_data`, mass crawled-not-indexed
 * → `index_rejection`, on-page/crawl faults → `crawl_blocked`).
 */
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
  const unknown = countSearchConsoleIssues(issues, 'unknown_to_google')
  const discovered = countSearchConsoleIssues(issues, 'discovered_not_indexed')
  const crawled = countSearchConsoleIssues(issues, 'crawled_not_indexed')
  // not_found / soft_404 are NOT hard faults — a 404 is a missing page (often
  // an intentionally retired one), a 5xx is a broken one. Only the latter blocks.
  const gscCrawlBlocks = countSearchConsoleIssues(issues, 'blocked_robots', 'server_error', 'access_denied', 'forbidden')
  // On-page faults from the crawl audit join GSC crawl reasons. `noindex` is
  // EXCLUDED — it is usually intentional (the v1 model mis-flagged it).
  const hardBlocks = gscCrawlBlocks + (input.crawlAuditBlockerCount ?? 0)
  // Clamp to the non-indexed pool. A canonical mismatch only blocks indexability
  // when it keeps a page OUT of the index — a mismatch on a page Google indexed
  // anyway is not a blocker. So the blocking count can never exceed `notIndexed`.
  // This defends the verdict against a dataset divergence: the unhead.unjs.io bug
  // fed "31 canonical mismatches" against an 8-URL funnel where all 8 were indexed
  // (notIndexed = 0), firing `indexability_blocked` on a fully-indexed sample. An
  // unbounded, differently-scoped count must never out-vote the funnel.
  const canonicalMismatches = Math.min(notIndexed, input.canonicalMismatchCount ?? countSearchConsoleIssues(issues, 'canonical_mismatch'))
  let visibleNoClickPages = 0
  let poorPositionPages = 0
  for (const page of input.pageInventory ?? []) {
    if (page.impressions < 50)
      continue
    if (page.clicks === 0)
      visibleNoClickPages++
    if ((page.position ?? 0) > 20)
      poorPositionPages++
  }
  const ctrOutlierCount = input.ctrOutlierCount ?? 0

  // ── v2 axes ────────────────────────────────────────────────────────────────
  const traj = input.trajectory ?? null
  const impressions28d = input.impressions28d ?? null
  const clicks90d = traj?.clicksPct90d ?? null
  const imp90d = traj?.impressionsPct90d ?? null
  const posDelta90d = traj?.positionDelta90d ?? null
  const clicks28d = traj?.clicksPct28d ?? null
  const clicksPrior28d = traj?.clicksPrior28d ?? null

  const isGrowing = (clicks90d != null && clicks90d > GROWTH_CLICKS_PCT_90D)
    || (imp90d != null && imp90d > GROWTH_IMPRESSIONS_PCT_90D && posDelta90d != null && posDelta90d < 0)
  // Both windows down AND enough prior traffic for the drop to be meaningful.
  const isDeclining = clicks90d != null && clicks90d < DECLINE_CLICKS_PCT
    && clicks28d != null && clicks28d < DECLINE_CLICKS_PCT
    && clicksPrior28d != null && clicksPrior28d >= MIN_DECLINE_PRIOR_CLICKS
  const isNascent = impressions28d != null && impressions28d < NASCENT_IMPRESSIONS_28D
  const isEstablished = impressions28d != null && impressions28d >= ESTABLISHED_IMPRESSIONS_28D
  const hasHardBlocker = hardBlocks > Math.max(10, totalUrls * 0.05)

  // Hard technical faults (server errors / broken links / access) win over
  // everything except connection — even on a growing site they need a flag.
  if (hasHardBlocker) {
    return stage('crawl_blocked', [
      { label: 'Crawl / on-page faults', value: formatSearchConsoleCount(hardBlocks), source: 'indexing' },
      { label: 'Indexed pages', value: `${formatSearchConsoleCount(indexed)} of ${formatSearchConsoleCount(totalUrls)}`, source: 'indexing' },
    ])
  }

  // Decline, on the robust windows only (never the lag-poisoned 7-day signal).
  if (isDeclining) {
    return stage('declining_visibility', [
      { label: 'Clicks 90d', value: `${clicks90d!.toFixed(1)}%`, source: 'performance' },
      { label: 'Clicks 28d', value: `${clicks28d!.toFixed(1)}%`, source: 'performance' },
    ])
  }

  // GROWTH OVERRIDE — discoverable, indexed-enough, trending up. Coverage% and
  // intentional noindex are irrelevant here; the next work is expansion. This
  // sits above mass-rejection and the maturity floor: a growing site is left
  // to keep expanding regardless of its non-indexed pool.
  if (isGrowing) {
    return stage('healthy_growth_ready', [
      // Hard faults below the stage-flip floor still get surfaced as a blocker
      // count even while growing — they remain real Sprint findings, so the card
      // must not claim "0 blockers" while the Top Issues list routes them to the
      // board. The STAGE stays growth-ready (one small fault should not derail a
      // growing site); only the evidence is made honest.
      ...(hardBlocks > 0 ? [{ label: 'Critical blockers', value: formatSearchConsoleCount(hardBlocks), source: 'indexing' as const }] : []),
      ...(clicks90d != null ? [{ label: 'Clicks 90d', value: signedPct1(clicks90d), source: 'performance' as const }] : []),
      ...(imp90d != null ? [{ label: 'Impressions 90d', value: signedPct1(imp90d), source: 'performance' as const }] : []),
      ...((input.recoverableBacklinkCount ?? 0) > 0 ? [{ label: 'Recoverable backlinks', value: formatSearchConsoleCount(input.recoverableBacklinkCount!), source: 'performance' as const }] : []),
      ...((input.competitorGapCount ?? 0) > 0 ? [{ label: 'Competitor content gaps', value: formatSearchConsoleCount(input.competitorGapCount!), source: 'performance' as const }] : []),
    ])
  }

  // Mass crawled-but-rejected on a large site = content quality. Diagnosable
  // regardless of traffic maturity (Google actively crawled and refused these),
  // so it sits ABOVE the nascent floor.
  if (crawled > Math.max(10, totalUrls * 0.30) && totalUrls > 500) {
    return stage('index_rejection', [
      { label: 'Crawled, not indexed', value: formatSearchConsoleCount(crawled), source: 'indexing' },
      { label: 'Not indexed', value: formatSearchConsoleCount(notIndexed), source: 'indexing' },
    ])
  }

  // Maturity floor: too little traffic to diagnose coverage. Catches brand-new
  // sites the v1 model wrongly flagged as a discovery defect.
  if (isNascent) {
    return stage('waiting_for_data', [
      { label: 'Impressions (28d)', value: formatSearchConsoleCount(impressions28d ?? 0), source: 'performance' },
      { label: 'Indexed pages', value: `${formatSearchConsoleCount(indexed)} of ${formatSearchConsoleCount(totalUrls)}`, source: 'indexing' },
    ])
  }

  // Discovery gap — only for non-established sites (a growing/established site
  // never lands here). Sitemap urlCount is intentionally NOT a trigger: GSC
  // often reports it null, which the v1 model mistook for "no coverage".
  if (!isEstablished && (sitemaps.length === 0 || sitemapErrors > 0 || unknown > Math.max(5, totalUrls * 0.1))) {
    return stage('weak_discovery', [
      { label: 'Sitemaps', value: sitemaps.length === 0 ? 'None registered' : `${formatSearchConsoleCount(sitemapErrors)} errors`, source: 'sitemap' },
      ...(unknown > 0 ? [{ label: 'Unknown URLs', value: formatSearchConsoleCount(unknown), source: 'indexing' as const }] : []),
    ])
  }

  if (discovered > Math.max(10, totalUrls * 0.15)) {
    return stage('discovery_backlog', [
      { label: 'Discovered, not crawled', value: formatSearchConsoleCount(discovered), source: 'indexing' },
      { label: 'Indexed pages', value: `${indexedPercent.toFixed(1)}%`, source: 'indexing' },
    ])
  }

  if (canonicalMismatches > Math.max(5, totalUrls * 0.05)) {
    return stage('indexability_blocked', [
      { label: 'Canonical mismatches', value: formatSearchConsoleCount(canonicalMismatches), source: 'canonical' },
    ])
  }

  // Benchmark CTR against site purpose. Informational types (docs/blog/portfolio)
  // earn structurally low CTR — the answer is often in the SERP — so raise the
  // bar: require a majority of pages to be impression-rich-but-clickless, and
  // don't fire on the global-curve CTR-outlier count alone.
  const lowCtrType = siteTypeBaseline(input.siteType).ctrExpectation === 'low'
  const noClickShare = lowCtrType ? 0.5 : 0.25
  const noClickTrigger = visibleNoClickPages >= Math.max(1, (input.pageInventory?.length ?? 0) * noClickShare)
  if ((ctrOutlierCount > 0 && !lowCtrType) || noClickTrigger) {
    return stage('visible_not_clicked', [
      ...(ctrOutlierCount > 0 ? [{ label: 'CTR outliers', value: formatSearchConsoleCount(ctrOutlierCount), source: 'performance' as const }] : []),
      ...(visibleNoClickPages > 0 ? [{ label: 'Visible, no clicks', value: formatSearchConsoleCount(visibleNoClickPages), source: 'performance' as const }] : []),
    ])
  }

  if (poorPositionPages >= Math.max(1, (input.pageInventory?.length ?? 0) * 0.25)) {
    return stage('ranking_stalled', [
      { label: 'Low-ranking visible pages', value: formatSearchConsoleCount(poorPositionPages), source: 'performance' },
    ])
  }

  return stage('healthy_growth_ready', [
    { label: 'Indexed', value: `${indexedPercent.toFixed(1)}%`, source: 'indexing' },
    // Honest count, not a hardcoded 0: hard faults below the stage-flip floor
    // (server/access/robots crawl blocks) are still real Sprint findings the
    // Top Issues list routes to the board. Reporting the true number keeps the
    // card from contradicting that list.
    { label: 'Critical blockers', value: formatSearchConsoleCount(hardBlocks), source: 'indexing' },
  ])
}
