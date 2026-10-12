// Site triage: two independent axes behind one headline.
//
//   maturity branch → ( REACH stage  ×  HEALTH stage )
//
// REACH classifies observed search visibility. HEALTH applies warning thresholds
// to supplied inspection and crawl observations, with purpose-aware exclusions.
// These heuristics do not establish the cause of a visibility or indexing change.
// A HEALTH warning leads the headline; otherwise REACH leads.
// `quality_rejection` is a preserved public tag for crawled-not-indexed and
// soft-404 observations. Neither state establishes a quality violation.

import type { SearchConsoleStageIssue } from './search-console-stage'
import { countSearchConsoleIssues, formatSearchConsoleCount } from './search-console-signals'
import { normalizeSiteType } from './site-baseline'

export type ReachStage
  = | 'emerging' // observed, with too little current reach for a comparative claim
    | 'growing' // established + trending up
    | 'plateaued' // established + flat
    | 'mixed' // reliable recent signals do not establish one direction
    | 'insufficient_data' // missing or incomplete comparison observations
    | 'declining' // established + sustained drop (still alive)
    | 'faded' // Stored legacy tag. New sustained visibility collapses use declining.
    | 'decayed' // Legacy tag for current impressions with very low CTR after prior visibility.

export type HealthStage
  = | 'healthy'
    | 'crawl_faults' // real 5xx / broken links on pages that matter
    | 'quality_rejection' // Legacy tag for a high crawled-not-indexed or soft-404 share; not a causal diagnosis.
    | 'not_indexed' // Discovered, crawled-not-indexed and soft-404 observations meet the warning threshold.

export interface TriageEvidence {
  label: string
  value: string
}

/**
 * Distance-to-next-stage for one axis, so the UI never re-derives thresholds.
 *
 * `direction`:
 *  - `advance` — up-path rung (emerging → growing). `pct` = value/target.
 *  - `escape`  — off-ramp recovery (declining/faded/decayed) or a held health gate
 *    (crawl_faults/quality_rejection). `pct` = inverse distance: closer to passing ⇒ higher.
 *  - `sustain` — already good (growing/healthy). `nextStage` null, `pct` 1, framed as momentum.
 *
 * `gapLabel` is always a concrete count (pages/clicks/points), never a bare %.
 */
export interface StageProgression {
  nextStage: ReachStage | HealthStage | null
  metric: string
  value: number
  target: number
  pct: number
  gapLabel: string
  direction: 'advance' | 'escape' | 'sustain'
}

export interface ReachVerdict {
  stage: ReachStage
  summary: string
  primaryAction: string
  evidence: TriageEvidence[]
  progression: StageProgression
}

export interface HealthVerdict {
  stage: HealthStage
  summary: string
  primaryAction: string
  evidence: TriageEvidence[]
  progression: StageProgression
}

export interface SiteTriage {
  /** Absent on stored verdicts produced before complete-period classification. */
  algorithmVersion?: 4
  reach: ReachVerdict
  health: HealthVerdict
  /** Which axis leads the dashboard headline. */
  headline: 'reach' | 'health'
}

export interface SiteTriageInput {
  /** Last complete reporting date of the current 28-day period. */
  periodEnd?: string | null
  /** Date-ascending, complete daily observations ending at the stable reporting date. */
  daily?: Array<{ date: string, clicks: number, impressions: number }> | null
  // ── maturity + reach (GSC, lag-trimmed windows) ──
  /** Impressions over the trailing 28 days — the maturity tier. */
  impressions28d?: number | null
  /** Lifetime-ish impressions (trailing 12 months) — separates new from decayed/faded. */
  impressions12m?: number | null
  /** Absolute clicks over the trailing 28 days — for the clicks≪impressions decay tell. */
  clicks28d?: number | null
  clicksPct90d?: number | null
  clicksPct28d?: number | null
  /** Absolute prior-28d clicks — gates decline so a % crash on trivial traffic isn't a false decline. */
  clicksPrior28d?: number | null
  impressionsPct90d?: number | null
  positionDelta90d?: number | null
  /** Recent three-week maximum divided by the median of four prior weeks. */
  livenessRatio?: number | null
  // ── health (indexing reasons + crawl audit + purpose) ──
  totalUrls?: number | null
  indexed?: number | null
  issues?: SearchConsoleStageIssue[] | null
  /** Real on-page faults from the crawl audit: 5xx, broken internal links/images. Excludes intentional noindex/404. */
  crawlAuditBlockerCount?: number | null
  /** AI profile type — drives purpose-expected subtraction. */
  siteType?: string | null
}

// ── thresholds (docs §10; derived from the 12-site distribution) ──
const MIN_GROWTH_IMPRESSIONS_28D = 1000
// crawl_faults floor sits between scripts.nuxt.com (9 server errors, tolerable) and
// newworldartists.net (137, broken); 3% share catches large-site breakage.
const HARD_BLOCK_FLOOR = 10
const HARD_BLOCK_SHARE = 0.03
// Preserved quality_rejection category: observed not-indexed share, not an inferred cause.
const REJECT_SHARE = 0.3
const REJECT_MIN = 50

/**
 * Compare three complete recent weeks with the median of four prior weeks.
 * The caller excludes reporting lag by date before supplying the daily series.
 * Known zero-impression days remain observations. Sparse baselines return null.
 */
export function reachLivenessRatio(daily: Array<{ date?: string, impressions: number }> | null | undefined): number | null {
  if (!daily || daily.length < 49)
    return null
  const observations = daily.slice(-49)
  if (observations.some(row => row.date != null)
    && !completeDates(observations.map(row => ({ date: row.date ?? '' })))) {
    return null
  }
  const series = observations.map(d => d.impressions)
  if (series.some(value => !Number.isFinite(value) || value < 0))
    return null
  const weeks = Array.from({ length: 7 }, (_, index) =>
    series.slice(index * 7, (index + 1) * 7).reduce((sum, value) => sum + value, 0))
  const baselineWeeks = weeks.slice(0, 4).sort((a, b) => a - b)
  const baseline = (baselineWeeks[1]! + baselineWeeks[2]!) / 2
  return baseline >= 250 ? Math.max(...weeks.slice(4)) / baseline : null
}

function clamp01(n: number): number {
  if (!Number.isFinite(n))
    return 0
  return Math.min(1, Math.max(0, n))
}

/** Signed percentage, e.g. -85 → "-85%", 42 → "+42%". */
function pctStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n)}%`
}

/**
 * `advance` progression: climbing toward `target`. `pct` = value/target clamped.
 * Used for up-path rungs where a larger value is better (impressions, growth %).
 */
function advance(
  nextStage: ReachStage | HealthStage,
  metric: string,
  value: number,
  target: number,
  gapLabel: string,
): StageProgression {
  return { nextStage, metric, value, target, pct: clamp01(value / target), gapLabel, direction: 'advance' }
}

/**
 * `escape` progression for a "reduce" gate where a SMALLER value passes
 * (faults, rejection share). `pct` = inverse distance: at/under target ⇒ 1,
 * at 2× target ⇒ 0, linear between.
 */
function escapeReduce(
  nextStage: ReachStage | HealthStage,
  metric: string,
  value: number,
  target: number,
  gapLabel: string,
): StageProgression {
  const pct = target <= 0 ? (value <= 0 ? 1 : 0) : clamp01(2 - value / target)
  return { nextStage, metric, value, target, pct, gapLabel, direction: 'escape' }
}

/** `escape` progression for an off-ramp where a larger value is better. */
function escapeToward(
  nextStage: ReachStage | HealthStage,
  metric: string,
  value: number,
  target: number,
  gapLabel: string,
): StageProgression {
  return { nextStage, metric, value, target, pct: clamp01(value / target), gapLabel, direction: 'escape' }
}

/** `sustain` progression: already good (growing/healthy). Full bar, framed as momentum. */
function sustain(metric: string, value: number, gapLabel: string): StageProgression {
  return { nextStage: null, metric, value, target: value, pct: 1, gapLabel, direction: 'sustain' }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_COPY: Record<HealthStage, Pick<HealthVerdict, 'summary' | 'primaryAction'>> = {
  healthy: {
    summary: 'Available observations do not exceed the indexing warning thresholds.',
    primaryAction: 'Review inspection coverage and freshness before deciding whether indexing needs attention.',
  },
  crawl_faults: {
    summary: 'Available observations show access faults or broken links above the warning threshold.',
    primaryAction: 'Fix the 5xx and broken URLs; return 410/404 for pages you retire on purpose.',
  },
  not_indexed: {
    summary: 'Saved inspections show a substantial share of known URLs are discovered or crawled but not indexed.',
    primaryAction: 'Inspect affected URLs and check discovery, responses, and canonical URLs before choosing changes.',
  },
  quality_rejection: {
    summary: 'Saved inspections show many crawled or soft-404 URLs are not indexed. These states do not establish a quality cause.',
    primaryAction: 'Inspect affected URLs and check their content, responses, and canonical URLs before choosing changes.',
  },
}

/** Is this an events/agency-style site that legitimately retires URLs (clean 404/410, no 5xx)? */
function isIntentionalRetirementSite(input: SiteTriageInput, notFound: number, serverError: number): boolean {
  const type = normalizeSiteType(input.siteType)
  const typeMatches = type === 'agency' || type === 'portfolio' || type === 'other'
  // Structural fingerprint when profile is null/ambiguous: many 404 + ~no 5xx.
  const fingerprint = notFound > 50 && serverError <= Math.max(5, notFound * 0.1)
  return typeMatches && fingerprint
}

export function classifyHealthStage(input: SiteTriageInput): HealthVerdict {
  const issues = input.issues ?? []
  const totalUrls = input.totalUrls ?? 0
  const noindex = countSearchConsoleIssues(issues, 'noindex')
  const notFound = countSearchConsoleIssues(issues, 'not_found')
  const softFound = countSearchConsoleIssues(issues, 'soft_404')
  const serverError = countSearchConsoleIssues(issues, 'server_error', 'blocked_robots', 'access_denied', 'forbidden')
  const crawledNotIndexed = countSearchConsoleIssues(issues, 'crawled_not_indexed')
  const discoveredNotIndexed = countSearchConsoleIssues(issues, 'discovered_not_indexed')

  const intentionalDead = isIntentionalRetirementSite(input, notFound, serverError) ? notFound : 0
  const indexableUrls = Math.max(1, totalUrls - noindex - intentionalDead)

  // Real faults: 5xx / access / broken — NOT not_found or soft_404 (a 404 is a
  // missing page, a 5xx is a broken one; only the latter is a hard fault).
  const hardBlocks = serverError + (input.crawlAuditBlockerCount ?? 0)
  const faultTarget = Math.max(HARD_BLOCK_FLOOR, indexableUrls * HARD_BLOCK_SHARE)
  if (hardBlocks > faultTarget) {
    const toFix = Math.ceil(hardBlocks - faultTarget)
    return {
      stage: 'crawl_faults',
      ...HEALTH_COPY.crawl_faults,
      evidence: [{ label: 'Access faults (5xx / broken)', value: formatSearchConsoleCount(hardBlocks) }],
      progression: escapeReduce(
        'healthy',
        'access faults',
        hardBlocks,
        faultTarget,
        `${formatSearchConsoleCount(hardBlocks)} faults. About ${formatSearchConsoleCount(toFix)} fewer would meet the warning threshold.`,
      ),
    }
  }

  // This legacy category combines observed not-indexed states. Neither state proves a quality cause.
  const rejectPool = crawledNotIndexed + softFound
  if (totalUrls > 0 && rejectPool > REJECT_MIN && rejectPool / totalUrls >= REJECT_SHARE) {
    const share = rejectPool / totalUrls
    return {
      stage: 'quality_rejection',
      ...HEALTH_COPY.quality_rejection,
      evidence: [
        { label: 'Crawled not indexed or soft 404', value: formatSearchConsoleCount(rejectPool) },
        { label: 'Share of known URLs', value: `${(share * 100).toFixed(0)}%` },
      ],
      progression: escapeReduce(
        'healthy',
        'crawled-not-indexed or soft-404 share',
        share,
        REJECT_SHARE,
        `${(share * 100).toFixed(0)}% of known URLs. This classification applies at 30% or more, with over 50 affected URLs.`,
      ),
    }
  }

  // Site-wide not indexed: Discovered URLs were never crawled, so they are not a
  // quality rejection. Together with the crawled and soft 404 URLs they can
  // still dominate the known URLs. Crawled alone dominating stays above.
  const notIndexedPool = rejectPool + discoveredNotIndexed
  if (totalUrls > 0 && notIndexedPool > REJECT_MIN && notIndexedPool / totalUrls >= REJECT_SHARE) {
    const share = notIndexedPool / totalUrls
    return {
      stage: 'not_indexed',
      ...HEALTH_COPY.not_indexed,
      evidence: [
        { label: 'Discovered, currently not indexed', value: formatSearchConsoleCount(discoveredNotIndexed) },
        { label: 'Crawled not indexed or soft 404', value: formatSearchConsoleCount(rejectPool) },
        { label: 'Share of known URLs', value: `${(share * 100).toFixed(0)}%` },
      ],
      progression: escapeReduce(
        'healthy',
        'not-indexed share',
        share,
        REJECT_SHARE,
        `${(share * 100).toFixed(0)}% of known URLs. This classification applies at 30% or more, with over 50 affected URLs.`,
      ),
    }
  }

  return {
    stage: 'healthy',
    ...HEALTH_COPY.healthy,
    ...(totalUrls <= 0
      ? {
          summary: 'No known URL count is available to assess indexing.',
          primaryAction: 'Collect URL Inspection results before assessing indexing.',
        }
      : {}),
    evidence: [],
    progression: sustain('indexing health', 1, totalUrls <= 0
      ? 'Indexing assessment unavailable without a known URL count.'
      : 'No warning threshold exceeded in available observations. This does not confirm every URL is indexed.'),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REACH
// ─────────────────────────────────────────────────────────────────────────────

const REACH_COPY: Record<ReachStage, Pick<ReachVerdict, 'summary' | 'primaryAction'>> = {
  emerging: {
    summary: 'Search observations are too sparse to establish a click trend.',
    primaryAction: 'Review pages and queries with recorded impressions before choosing further work.',
  },
  growing: {
    summary: 'Search clicks or impressions rose across two complete 28-day periods and at least three paired weeks.',
    primaryAction: 'Review growing pages and relevant search queries for further opportunities.',
  },
  plateaued: {
    summary: 'Clicks and impressions changed by no more than 10% across two complete 28-day periods.',
    primaryAction: 'Review page and query changes before choosing further work.',
  },
  mixed: {
    summary: 'Recent search observations do not show a consistent direction.',
    primaryAction: 'Compare clicks, impressions, and weekly changes before choosing further work.',
  },
  insufficient_data: {
    summary: 'Complete daily observations are unavailable for two consecutive 28-day periods.',
    primaryAction: 'Collect complete search data before assessing the trend.',
  },
  declining: {
    summary: 'Search traffic fell across the recent complete reporting periods.',
    primaryAction: 'Investigate the losing pages, recent releases, and competitor moves before expanding.',
  },
  faded: {
    summary: 'Recent weekly impressions are below 20% of the peak week in the supplied history.',
    primaryAction: 'Compare the recent week with the peak. Investigate affected queries, pages, and inspection results.',
  },
  decayed: {
    summary: 'The Site still earns impressions, but its observed 28-day CTR is below 0.5%.',
    primaryAction: 'Review queries, positions, and search appearance before deciding whether pages need changes.',
  },
}

function reach(stage: ReachStage, evidence: TriageEvidence[], progression: StageProgression): ReachVerdict {
  return { stage, ...REACH_COPY[stage], evidence, progression }
}

interface Comparison { current: number, prior: number, pct: number | null, upWeeks: number, downWeeks: number, flatWeeks: number }

function compareWeeks(values: number[], weeklyMinimumChange: number): Comparison {
  const weeks = Array.from({ length: 8 }, (_, index) =>
    values.slice(index * 7, (index + 1) * 7).reduce((sum, value) => sum + value, 0))
  const prior = weeks.slice(0, 4).reduce((sum, value) => sum + value, 0)
  const current = weeks.slice(4).reduce((sum, value) => sum + value, 0)
  const materiallyChanged = (value: number, baseline: number, sign: 1 | -1): boolean =>
    sign * (value - baseline) >= Math.max(baseline * 0.2, weeklyMinimumChange)
  return {
    current,
    prior,
    pct: prior > 0 ? (current / prior - 1) * 100 : null,
    upWeeks: weeks.slice(4).filter((value, index) => materiallyChanged(value, weeks[index]!, 1)).length,
    downWeeks: weeks.slice(4).filter((value, index) => materiallyChanged(value, weeks[index]!, -1)).length,
    flatWeeks: weeks.slice(4).filter((value, index) => Math.abs(value - weeks[index]!) <= weeks[index]! * 0.1).length,
  }
}

type Direction = 'up' | 'down' | 'flat' | 'unclear'

function measuredDirection(comparison: Comparison, minimumChange: number): Direction {
  const { pct, current, prior, upWeeks, downWeeks } = comparison
  if (pct == null)
    return 'unclear'
  const delta = current - prior
  if (delta >= prior * 0.2 && delta >= minimumChange && upWeeks >= 3)
    return 'up'
  if (delta <= -prior * 0.2 && delta <= -minimumChange && downWeeks >= 3)
    return 'down'
  if (Math.abs(delta) <= prior * 0.1)
    return 'flat'
  return 'unclear'
}

/** Require real, consecutive dates. Missing rows are not invented zeroes. */
function completeDates(daily: Array<{ date: string }>): boolean {
  return daily.every((row, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date))
      return false
    const timestamp = Date.parse(row.date)
    return Number.isFinite(timestamp)
      && new Date(timestamp).toISOString().slice(0, 10) === row.date
      && (index === 0 || timestamp - Date.parse(daily[index - 1]!.date) === 86400000)
  })
}

export function classifyReachStage(input: SiteTriageInput): ReachVerdict {
  const impressions = input.impressions28d
  const evidence: TriageEvidence[] = impressions != null && Number.isFinite(impressions) && impressions >= 0
    ? [{ label: 'Impressions (28d)', value: formatSearchConsoleCount(impressions) }]
    : []
  const unavailable = (): ReachVerdict => reach('insufficient_data', evidence, {
    nextStage: null,
    metric: 'search data',
    value: 0,
    target: 56,
    pct: 0,
    gapLabel: 'Two complete 28-day periods are required.',
    direction: 'advance',
  })
  if (impressions == null || !Number.isFinite(impressions) || impressions < 0)
    return unavailable()
  const daily = input.daily?.slice(-56)
  if (!daily || daily.length < 56) {
    if (impressions < MIN_GROWTH_IMPRESSIONS_28D) {
      return reach('emerging', evidence, advance('growing', '28d impressions', impressions, MIN_GROWTH_IMPRESSIONS_28D, 'Build enough search visibility to measure a trend.'))
    }
    return unavailable()
  }
  if (!completeDates(daily) || daily.some(row =>
    !Number.isFinite(row.clicks) || row.clicks < 0 || !Number.isFinite(row.impressions) || row.impressions < 0)) {
    return unavailable()
  }
  if (input.periodEnd != null && daily.at(-1)!.date !== input.periodEnd)
    return unavailable()

  const clicks = compareWeeks(daily.map(row => row.clicks), 5)
  const visibility = compareWeeks(daily.map(row => row.impressions), 50)
  // A failed or mismatched aggregate window cannot be repaired by silently using another period.
  if (visibility.current !== impressions || (input.clicks28d != null && clicks.current !== input.clicks28d))
    return unavailable()
  const clicksDirection = measuredDirection(clicks, 20)
  const impressionsDirection = measuredDirection(visibility, 200)
  const comparisonEvidence: TriageEvidence[] = [
    ...evidence,
    { label: 'Clicks (28d)', value: formatSearchConsoleCount(clicks.current) },
    ...(clicks.pct != null ? [{ label: 'Clicks 28d', value: pctStr(clicks.pct) }] : []),
    ...(visibility.pct != null ? [{ label: 'Impressions 28d', value: pctStr(visibility.pct) }] : []),
  ]
  // Clicks lead when their baseline is measurable. Impressions may move in another direction.
  if (clicks.prior >= 50 && clicksDirection === 'down') {
    const recoveryTarget = Math.ceil(clicks.prior * 0.9)
    return reach('declining', comparisonEvidence, escapeToward(
      'plateaued',
      '28d clicks',
      clicks.current,
      recoveryTarget,
      `About ${formatSearchConsoleCount(Math.max(0, recoveryTarget - clicks.current))} more clicks would bring this period within 10% of the previous period.`,
    ))
  }
  if (clicks.prior >= 50 && clicks.current >= 50 && clicksDirection === 'up') {
    return reach('growing', comparisonEvidence, sustain('28d clicks growth', clicks.pct!, 'Clicks rose by at least 20% and 20 clicks in three or more paired weeks.'))
  }
  const liveness = reachLivenessRatio(daily)
  if (liveness != null && liveness < 0.2) {
    return {
      ...reach('declining', comparisonEvidence, escapeToward('plateaued', 'recent weekly impressions', liveness, 0.2, 'Raise recent weekly impressions to at least 20% of the prior baseline.')),
      summary: 'Impressions stayed below 20% of the prior weekly baseline for three consecutive weeks.',
    }
  }
  if (clicks.prior < 50 || clicks.current < 50) {
    if (visibility.prior >= 1000 && visibility.current >= 1000 && impressionsDirection === 'up') {
      return reach('growing', comparisonEvidence, sustain('28d impressions growth', visibility.pct!, 'Impressions rose by at least 20% and 200 impressions in three or more paired weeks.'))
    }
    return reach('emerging', comparisonEvidence, advance('growing', '28d clicks', Math.min(clicks.prior, clicks.current), 50, 'At least 50 clicks in each period are required to compare click trends.'))
  }
  if (clicksDirection === 'flat' && impressionsDirection === 'flat' && clicks.flatWeeks >= 3 && visibility.flatWeeks >= 3) {
    const growthTarget = Math.ceil(clicks.prior * 1.2)
    return reach('plateaued', comparisonEvidence, advance('growing', '28d clicks', clicks.current, growthTarget, `About ${formatSearchConsoleCount(Math.max(0, growthTarget - clicks.current))} more clicks would reach 20% growth over the previous period.`))
  }
  const growthTarget = Math.ceil(clicks.prior * 1.2)
  return reach('mixed', comparisonEvidence, advance('growing', '28d clicks', clicks.current, growthTarget, `About ${formatSearchConsoleCount(Math.max(0, growthTarget - clicks.current))} more clicks would reach 20% growth over the previous period.`))
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED TRIAGE
// ─────────────────────────────────────────────────────────────────────────────

export function classifySiteTriage(input: SiteTriageInput): SiteTriage {
  const health = classifyHealthStage(input)
  const reachVerdict = classifyReachStage(input)
  // A real, (already purpose-adjusted) health blocker explains/over-rides the
  // reach story and takes the headline; otherwise reach leads.
  const headline: 'reach' | 'health' = health.stage === 'healthy' ? 'reach' : 'health'
  return { algorithmVersion: 4, reach: reachVerdict, health, headline }
}
