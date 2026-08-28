// v3 site triage: two orthogonal axes behind one headline.
//
//   maturity branch → ( REACH stage  ×  HEALTH stage )
//
// REACH answers "is the site winning organic visibility, and if not, why" —
// because a low-reach site's CAUSE (new / decayed / faded / quality-suppressed)
// IS the diagnosis. HEALTH answers "can Google crawl + index the pages that
// SHOULD be indexed", purpose-aware (pSEO expects a long non-indexed tail;
// event sites expect retired pages). The headline picks the dominant axis: a
// real, non-purpose-expected HEALTH blocker wins, otherwise REACH leads and the
// other axis is an evidence sub-line.
//
// Soft quality violations (Google crawls a page then refuses to index it) are
// NOT exposed by the Search Console API — no Manual Actions / Security Issues
// endpoint exists — so `quality_rejection` is inferred from crawled-not-indexed
// share. See docs/search-console-stage-v2-audit.md §10.

import type { SearchConsoleStageIssue } from './search-console-stage'
import { countSearchConsoleIssues, formatSearchConsoleCount } from './search-console-signals'
import { normalizeSiteType } from './site-baseline'

export type ReachStage
  = | 'emerging' // observed, with too little current reach for a comparative claim
    | 'growing' // established + trending up
    | 'plateaued' // established + flat
    | 'declining' // established + sustained drop (still alive)
    | 'faded' // had real reach, recent window collapsed vs its own peak (spike→died)
    | 'decayed' // old, used to rank, eroded to staleness (impressions linger, clicks gone)

export type HealthStage
  = | 'healthy'
    | 'crawl_faults' // real 5xx / broken links on pages that matter
    | 'quality_rejection' // Google crawled then refused — soft quality / AI-spam suppression

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
  reach: ReachVerdict
  health: HealthVerdict
  /** Which axis leads the dashboard headline. */
  headline: 'reach' | 'health'
}

export interface SiteTriageInput {
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
  /** Latest complete week ÷ 90d peak week (lag-trimmed). <0.2 = faded (spike→died). */
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
const ESTABLISHED_IMPRESSIONS_28D = 20000
const MIN_HISTORY_IMPRESSIONS = 500
const GROWTH_CLICKS_PCT = 10
const GROWTH_IMPRESSIONS_PCT = 20
const DECLINE_CLICKS_PCT = -10
const MIN_DECLINE_PRIOR_CLICKS = 50
const FADED_LIVENESS = 0.2 // recent week <20% of peak week
const DECAY_CTR = 0.005 // clicks/impressions below this on an established base = eroded relevance
// crawl_faults floor sits between scripts.nuxt.com (9 server errors, tolerable) and
// newworldartists.net (137, broken); 3% share catches large-site breakage.
const HARD_BLOCK_FLOOR = 10
const HARD_BLOCK_SHARE = 0.03
// quality_rejection: Google crawled then refused a large share.
const REJECT_SHARE = 0.3
const REJECT_MIN = 50

/**
 * Reach liveness: latest complete week ÷ peak rolling-7d week over a daily
 * impressions series (typically the trailing 90 days). `<0.2` means recent
 * impressions have collapsed versus the site's own peak (spike→died) — the
 * signal a period-vs-prior delta cannot see. Trailing zero-impression days
 * (GSC reporting lag) are trimmed before the latest-week sum. Returns null when
 * the series is too short to judge.
 */
export function reachLivenessRatio(daily: Array<{ impressions: number }> | null | undefined): number | null {
  if (!daily || daily.length < 14)
    return null
  const series = daily.map(d => d.impressions)
  while (series.length && series[series.length - 1] === 0)
    series.pop()
  if (series.length < 14)
    return null
  const rolling7 = (end: number): number => {
    let sum = 0
    for (let i = Math.max(0, end - 6); i <= end; i++) sum += series[i]!
    return sum
  }
  const latestWeek = rolling7(series.length - 1)
  let peakWeek = 0
  for (let i = 6; i < series.length; i++) peakWeek = Math.max(peakWeek, rolling7(i))
  return peakWeek > 0 ? latestWeek / peakWeek : null
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
 * `escape` progression for an off-ramp where a larger value is better but the
 * site is below an exit threshold (declining clicks %, faded liveness, decayed CTR).
 * `pct` = value/target clamped — closer to the exit ⇒ higher. Negative values floor at 0.
 */
function escapeToward(
  nextStage: ReachStage | HealthStage,
  metric: string,
  value: number,
  target: number,
  gapLabel: string,
): StageProgression {
  return { nextStage, metric, value, target, pct: clamp01(value / target), gapLabel, direction: 'escape' }
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

/** `sustain` progression: already good (growing/healthy). Full bar, framed as momentum. */
function sustain(metric: string, value: number, gapLabel: string): StageProgression {
  return { nextStage: null, metric, value, target: value, pct: 1, gapLabel, direction: 'sustain' }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_COPY: Record<HealthStage, Pick<HealthVerdict, 'summary' | 'primaryAction'>> = {
  healthy: {
    summary: 'Google can crawl and index the pages that should be indexed.',
    primaryAction: 'No indexing cleanup needed — focus on reach.',
  },
  crawl_faults: {
    summary: 'Real access faults (server errors / broken links) are capping otherwise-indexable pages.',
    primaryAction: 'Fix the 5xx and broken URLs; return 410/404 for pages you retire on purpose.',
  },
  quality_rejection: {
    summary: 'Google is crawling pages and refusing to index them — a soft quality signal it never reports explicitly.',
    primaryAction: 'Consolidate or improve the rejected pages, or noindex the thin/low-value set.',
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
        `${formatSearchConsoleCount(hardBlocks)} faults — fix ~${formatSearchConsoleCount(toFix)} to clear the gate`,
      ),
    }
  }

  // Soft quality rejection: Google spent crawl budget then declined. soft_404
  // (thin/empty) counts here, not as a hard fault. Applies even to pSEO.
  const rejectPool = crawledNotIndexed + softFound
  if (totalUrls > 0 && rejectPool > REJECT_MIN && rejectPool / totalUrls >= REJECT_SHARE) {
    const share = rejectPool / totalUrls
    // Pages to clear so the remaining rejected share drops just under REJECT_SHARE.
    const toClear = Math.max(0, Math.ceil(rejectPool - REJECT_SHARE * totalUrls))
    return {
      stage: 'quality_rejection',
      ...HEALTH_COPY.quality_rejection,
      evidence: [
        { label: 'Crawled, then refused', value: formatSearchConsoleCount(rejectPool) },
        { label: 'Share of known URLs', value: `${(share * 100).toFixed(0)}%` },
      ],
      progression: escapeReduce(
        'healthy',
        'crawled-rejected share',
        share,
        REJECT_SHARE,
        `${(share * 100).toFixed(0)}% rejected — improve/consolidate ~${formatSearchConsoleCount(toClear)} pages to clear`,
      ),
    }
  }

  return {
    stage: 'healthy',
    ...HEALTH_COPY.healthy,
    evidence: [],
    progression: sustain('indexing health', 1, 'Indexable pages are getting indexed — no gate blocking reach.'),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REACH
// ─────────────────────────────────────────────────────────────────────────────

const REACH_COPY: Record<ReachStage, Pick<ReachVerdict, 'summary' | 'primaryAction'>> = {
  emerging: {
    summary: 'Search Console is ready. Search visibility is still limited.',
    primaryAction: 'Improve discovery and indexing, then build on pages that earn impressions.',
  },
  growing: {
    summary: 'Discoverable, indexed-enough, and trending up. The next work is expansion, not cleanup.',
    primaryAction: 'Expand: striking-distance pages, content gaps, authority.',
  },
  plateaued: {
    summary: 'Established but flat — visibility is steady, not compounding.',
    primaryAction: 'Refresh top pages and open a new content cluster to restart growth.',
  },
  declining: {
    summary: 'Established visibility is genuinely falling versus the previous period.',
    primaryAction: 'Investigate the losing pages, recent releases, and competitor moves before expanding.',
  },
  faded: {
    summary: 'The site had real reach that has collapsed — it spiked and is now near-invisible in search.',
    primaryAction: 'Diagnose the drop (quality, deindexing, lost rankings) — the 90-day total hides it; look at the recent week.',
  },
  decayed: {
    summary: 'Still shows for old terms but earns almost no clicks — the content has aged out of relevance.',
    primaryAction: 'Refresh the decayed top pages, or mark the site low-priority if it is no longer maintained.',
  },
}

function reach(stage: ReachStage, evidence: TriageEvidence[], progression: StageProgression): ReachVerdict {
  return { stage, ...REACH_COPY[stage], evidence, progression }
}

export function classifyReachStage(input: SiteTriageInput): ReachVerdict {
  const imp28d = input.impressions28d ?? 0
  const imp12m = input.impressions12m ?? null
  const clicks28d = input.clicks28d ?? null
  const clicks90dPct = input.clicksPct90d ?? null
  const clicks28dPct = input.clicksPct28d ?? null
  const priorClicks = input.clicksPrior28d ?? null
  const imp90dPct = input.impressionsPct90d ?? null
  const posDelta = input.positionDelta90d ?? null
  const liveness = input.livenessRatio ?? null

  const hadRealReach = (imp12m ?? imp28d) > MIN_HISTORY_IMPRESSIONS
  const hasGrowthEvidence = imp28d >= MIN_GROWTH_IMPRESSIONS_28D
  const isGrowing = hasGrowthEvidence && (
    (clicks90dPct != null && clicks90dPct > GROWTH_CLICKS_PCT)
    || (imp90dPct != null && imp90dPct > GROWTH_IMPRESSIONS_PCT && posDelta != null && posDelta < 0)
  )

  // Faded: a real-reach site whose latest week collapsed vs its own peak. This
  // is the spike→died case the 90d-vs-prior delta cannot see.
  if (hadRealReach && liveness != null && liveness < FADED_LIVENESS && !isGrowing) {
    const FADED_RECOVERY = 0.5
    return reach(
      'faded',
      [{ label: 'Recent week vs peak', value: `${(liveness * 100).toFixed(0)}%` }],
      escapeToward(
        'growing',
        'recent week vs peak (liveness)',
        liveness,
        FADED_RECOVERY,
        `recent week is ${(liveness * 100).toFixed(0)}% of peak — revive toward ~50%`,
      ),
    )
  }

  // Genuine decline: both windows down with a meaningful baseline to fall from.
  const isDeclining = clicks90dPct != null && clicks90dPct < DECLINE_CLICKS_PCT
    && clicks28dPct != null && clicks28dPct < DECLINE_CLICKS_PCT
    && priorClicks != null && priorClicks >= MIN_DECLINE_PRIOR_CLICKS
  if (isDeclining) {
    // Off-ramp recovery: the exit is 90d clicks climbing back above the decline
    // floor (−10%). value/target keep the signed metric the UI displays; pct is
    // inverse distance on the drop magnitude — at −10% ⇒ 1, at −20% ⇒ 0, so a
    // −12% site reads nearly-out and a −85% site reads far.
    return reach(
      'declining',
      [
        { label: 'Clicks 90d', value: pctStr(clicks90dPct!) },
        { label: 'Clicks 28d', value: pctStr(clicks28dPct!) },
      ],
      {
        nextStage: 'plateaued',
        metric: '90d clicks change',
        value: clicks90dPct!,
        target: DECLINE_CLICKS_PCT,
        pct: clamp01(2 - Math.abs(clicks90dPct!) / Math.abs(DECLINE_CLICKS_PCT)),
        gapLabel: `down ${pctStr(clicks90dPct!)} (90d) — recover clicks above ${pctStr(DECLINE_CLICKS_PCT)} to exit`,
        direction: 'escape',
      },
    )
  }

  if (isGrowing) {
    const clickGrowth = clicks90dPct != null && clicks90dPct > GROWTH_CLICKS_PCT
    const growthPct = clickGrowth ? clicks90dPct : (imp90dPct ?? clicks90dPct ?? 0)
    const growthMetric = clickGrowth ? '90d clicks growth' : '90d impressions growth'
    const growthLabel = clickGrowth
      ? `${pctStr(clicks90dPct!)} 90d clicks — comfortably growing; defend & expand`
      : `${pctStr(growthPct)} 90d impressions — comfortably growing; defend & expand`
    return reach(
      'growing',
      [
        ...(clicks90dPct != null ? [{ label: 'Clicks 90d', value: pctStr(clicks90dPct) }] : []),
        ...(imp90dPct != null ? [{ label: 'Impressions 90d', value: pctStr(imp90dPct) }] : []),
      ],
      sustain(growthMetric, growthPct, growthLabel),
    )
  }

  // Decayed: established lifetime base, not growing, impressions linger but
  // clicks have evaporated (aged-out content ranking for stale/low-intent terms).
  const ctr = clicks28d != null && imp28d > 0 ? clicks28d / imp28d : null
  if (hadRealReach && imp28d >= MIN_GROWTH_IMPRESSIONS_28D && ctr != null && ctr < DECAY_CTR) {
    return reach(
      'decayed',
      [
        { label: 'Impressions (28d)', value: formatSearchConsoleCount(imp28d) },
        { label: 'Clicks (28d)', value: formatSearchConsoleCount(clicks28d ?? 0) },
      ],
      escapeToward(
        'growing',
        'CTR (clicks/impressions)',
        ctr,
        DECAY_CTR,
        `${(ctr * 100).toFixed(2)}% CTR on ${formatSearchConsoleCount(imp28d)} impressions — refresh content toward ~${(DECAY_CTR * 100).toFixed(1)}%`,
      ),
    )
  }

  // Sites with enough reach advance through measured growth.
  const growthVal = clicks90dPct ?? 0
  const growthGap = Math.max(0, GROWTH_CLICKS_PCT - growthVal)
  const growthProgression = (stage: 'emerging' | 'plateaued'): StageProgression => advance(
    'growing',
    '90d clicks growth',
    growthVal,
    GROWTH_CLICKS_PCT,
    clicks90dPct != null
      ? `${pctStr(growthVal)} 90d clicks — need ${pctStr(growthGap)} more to clear the +${GROWTH_CLICKS_PCT}% growth bar`
      : `${stage === 'plateaued' ? 'flat' : 'rising'} — reach +${GROWTH_CLICKS_PCT}% 90d clicks growth to break into growing`,
  )

  // Established + neither up nor down → plateaued; small-but-real → emerging.
  if (imp28d >= ESTABLISHED_IMPRESSIONS_28D)
    return reach('plateaued', [{ label: 'Impressions (28d)', value: formatSearchConsoleCount(imp28d) }], growthProgression('plateaued'))
  if (imp28d < MIN_GROWTH_IMPRESSIONS_28D) {
    return reach(
      'emerging',
      [{ label: 'Impressions (28d)', value: formatSearchConsoleCount(imp28d) }],
      advance(
        'growing',
        '28d impressions',
        imp28d,
        MIN_GROWTH_IMPRESSIONS_28D,
        `${formatSearchConsoleCount(imp28d)} impressions in 28 days. Build enough visibility to measure growth reliably.`,
      ),
    )
  }
  return reach('plateaued', [{ label: 'Impressions (28d)', value: formatSearchConsoleCount(imp28d) }], growthProgression('plateaued'))
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
  return { reach: reachVerdict, health, headline }
}
