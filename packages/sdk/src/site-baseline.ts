// Site-type baselines + peer-relative goal derivation.
//
// A site's health and goal are not absolute: a docs site at 70% coverage with
// low CTR is healthy; an ecommerce site with the same numbers is not. This
// module turns the AI site categorisation (`sites.profile.type`, a 7-value
// enum) plus competitor peer metrics into (a) a per-type expectation profile
// the classifier can refine against, and (b) a peer-relative standing + goal.
//
// The per-type table is a hand-set v1 prior — there is no per-type benchmark
// data yet (only a global CTR-by-position curve). Tune as outcome data lands.

export type SiteType = 'saas' | 'ecommerce' | 'docs' | 'blog' | 'agency' | 'portfolio' | 'other'

const KNOWN_SITE_TYPES = new Set<SiteType>(['saas', 'ecommerce', 'docs', 'blog', 'agency', 'portfolio', 'other'])

/**
 * Normalise the AI profile `type` to the closed enum. The categoriser mostly
 * emits the 7 values but occasionally leaks free-text (e.g. "event") or null
 * (~40% of live sites are unprofiled) — everything unknown collapses to `other`
 * so downstream logic always has a defined bucket.
 */
export function normalizeSiteType(raw: string | null | undefined): SiteType {
  if (!raw)
    return 'other'
  const t = raw.toLowerCase().trim()
  return KNOWN_SITE_TYPES.has(t as SiteType) ? (t as SiteType) : 'other'
}

export interface SiteTypeBaseline {
  label: string
  /**
   * Whether indexed-coverage% is a meaningful health signal for this type.
   * docs/blog/portfolio accumulate intentional low-value pages (tags, versions,
   * pagination, archives) so coverage% is noise; ecommerce/saas/agency care.
   */
  coverageMatters: boolean
  /**
   * Typical click-through at good positions. Informational types (docs/blog)
   * earn structurally lower CTR (answer shown in SERP, multi-page research), so
   * a low CTR is NOT a defect — the classifier raises the visible-not-clicked
   * bar for these.
   */
  ctrExpectation: 'low' | 'medium' | 'high'
  /** The default growth lever when the site is healthy and leading. */
  primaryGoal: 'content' | 'authority' | 'conversion' | 'coverage'
}

export const SITE_TYPE_BASELINE: Record<SiteType, SiteTypeBaseline> = {
  docs: { label: 'Documentation', coverageMatters: false, ctrExpectation: 'low', primaryGoal: 'content' },
  blog: { label: 'Blog / content', coverageMatters: false, ctrExpectation: 'low', primaryGoal: 'content' },
  portfolio: { label: 'Portfolio', coverageMatters: false, ctrExpectation: 'low', primaryGoal: 'content' },
  saas: { label: 'SaaS', coverageMatters: true, ctrExpectation: 'medium', primaryGoal: 'authority' },
  agency: { label: 'Agency', coverageMatters: true, ctrExpectation: 'medium', primaryGoal: 'authority' },
  ecommerce: { label: 'Ecommerce', coverageMatters: true, ctrExpectation: 'high', primaryGoal: 'coverage' },
  other: { label: 'General', coverageMatters: true, ctrExpectation: 'medium', primaryGoal: 'content' },
}

export function siteTypeBaseline(raw: string | null | undefined): SiteTypeBaseline {
  return SITE_TYPE_BASELINE[normalizeSiteType(raw)]
}

export type PeerStanding = 'leader' | 'on_par' | 'behind' | 'unknown'

/** How much to trust the standing: a median over 1–2 peers is noisy. */
export type PeerConfidence = 'high' | 'low' | 'none'

// A median needs at least this many peers to be trusted (live data: saas/
// ecommerce/agency average 3–4 tracked competitors; blog/portfolio 1–2).
const MIN_CONFIDENT_PEERS = 3

/**
 * Peer metrics from tracked competitors (`siteCompetitors`). Domain rank is the
 * DataForSEO-derived 0–100 score (`min(100, log10(keywordCount)*20)`), NOT a
 * true authority metric — good enough for relative standing within a peer set.
 * The site's OWN metrics are not stored alongside competitors, so callers must
 * supply them (one cheap cached `estimateDomainTraffic` call).
 */
export interface PeerBaselineInput {
  siteDomainRank?: number | null
  siteOrganicTraffic?: number | null
  competitorDomainRanks?: number[] | null
  competitorOrganicTraffic?: number[] | null
}

// A site leads when it clears the peer median by this margin, trails when it
// falls below the inverse. ±15% band keeps "on par" from flapping on noise.
const LEADER_RATIO = 1.15
const BEHIND_RATIO = 0.85

function median(values: number[] | null | undefined): number | null {
  if (!values || values.length === 0)
    return null
  const xs = [...values].sort((a, b) => a - b)
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2
}

export interface SiteBaseline {
  siteType: SiteType
  baseline: SiteTypeBaseline
  peerStanding: PeerStanding
  peerConfidence: PeerConfidence
  peerMedianDomainRank: number | null
  peerMedianOrganicTraffic: number | null
  /** Human-facing goal headline combining type + standing. */
  recommendedGoal: string
  goalKind: SiteTypeBaseline['primaryGoal']
}

/** Standing is decided on domain rank first; organic traffic breaks the tie. */
export function derivePeerStanding(input: PeerBaselineInput): {
  standing: PeerStanding
  confidence: PeerConfidence
  peerMedianDomainRank: number | null
  peerMedianOrganicTraffic: number | null
} {
  const peerMedianDomainRank = median(input.competitorDomainRanks)
  const peerMedianOrganicTraffic = median(input.competitorOrganicTraffic)
  const peerCount = Math.max(input.competitorDomainRanks?.length ?? 0, input.competitorOrganicTraffic?.length ?? 0)
  const confidence: PeerConfidence = peerCount === 0 ? 'none' : peerCount >= MIN_CONFIDENT_PEERS ? 'high' : 'low'

  const compare = (site: number | null | undefined, peer: number | null): PeerStanding | null => {
    if (site == null || peer == null || peer === 0)
      return null
    const ratio = site / peer
    if (ratio >= LEADER_RATIO)
      return 'leader'
    if (ratio <= BEHIND_RATIO)
      return 'behind'
    return 'on_par'
  }

  const standing = compare(input.siteDomainRank, peerMedianDomainRank)
    ?? compare(input.siteOrganicTraffic, peerMedianOrganicTraffic)
    ?? 'unknown'

  return { standing, confidence, peerMedianDomainRank, peerMedianOrganicTraffic }
}

const GOAL_HEADLINE: Record<SiteTypeBaseline['primaryGoal'], string> = {
  content: 'publish & expand content',
  authority: 'build authority & backlinks',
  conversion: 'lift conversion & CTR',
  coverage: 'expand indexable catalogue',
}

/**
 * Combine the site type with its peer standing into a relative goal. A leader
 * defends and expands on its type's lever; a site that's behind closes the gap
 * on the same lever; unknown standing falls back to the type default.
 */
export function deriveSiteBaseline(rawType: string | null | undefined, peer: PeerBaselineInput = {}): SiteBaseline {
  const siteType = normalizeSiteType(rawType)
  const baseline = SITE_TYPE_BASELINE[siteType]
  const { standing, confidence, peerMedianDomainRank, peerMedianOrganicTraffic } = derivePeerStanding(peer)
  const lever = GOAL_HEADLINE[baseline.primaryGoal]

  const recommendedGoal
    = standing === 'behind'
      ? `Close the gap on peers — ${lever}`
      : standing === 'leader'
        ? `Defend the lead — ${lever}`
        : standing === 'on_par'
          ? `Pull ahead of peers — ${lever}`
          : `${baseline.label}: ${lever}`

  return {
    siteType,
    baseline,
    peerStanding: standing,
    peerConfidence: confidence,
    peerMedianDomainRank,
    peerMedianOrganicTraffic,
    recommendedGoal,
    goalKind: baseline.primaryGoal,
  }
}
