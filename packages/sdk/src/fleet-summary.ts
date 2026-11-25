import type {
  FleetSummarySortDir,
  FleetSummarySortField,
  FleetSummaryV1Data,
  FleetSummaryV1DeduplicatedTotals,
  FleetSummaryV1Deltas,
  FleetSummaryV1Site,
  FleetSummaryV1Totals,
} from '@gscdump/contracts/v1'
import { fleetSummarySortFormula } from '@gscdump/contracts/v1'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type FleetSummarySiteOutcome = DistributiveOmit<FleetSummaryV1Site, 'sameSiteUrlAs'>

export interface BuildFleetSummaryInput {
  window: FleetSummaryV1Data['window']
  searchType: FleetSummaryV1Data['searchType']
  sortBy: FleetSummarySortField
  sortDir: FleetSummarySortDir
  sites: readonly FleetSummarySiteOutcome[]
}

/** Absolute and percentage deltas between two windows. Percentage is null when the baseline is zero. */
export function computeFleetDeltas(
  current: FleetSummaryV1Totals,
  previous: FleetSummaryV1Totals,
): FleetSummaryV1Deltas {
  const clicks = current.clicks - previous.clicks
  const impressions = current.impressions - previous.impressions
  return {
    clicks,
    clicksPct: previous.clicks > 0 ? ((current.clicks / previous.clicks) - 1) * 100 : null,
    impressions,
    impressionsPct: previous.impressions > 0 ? ((current.impressions / previous.impressions) - 1) * 100 : null,
    ctr: current.ctr - previous.ctr,
    position: current.position != null && previous.position != null
      ? current.position - previous.position
      : null,
  }
}

/** Link duplicate `siteUrl` registrations across partner and native Sites. */
export function linkSameSiteUrls(
  sites: readonly FleetSummarySiteOutcome[],
): FleetSummaryV1Site[] {
  const byUrl = new Map<string, string[]>()
  for (const site of sites) {
    const ids = byUrl.get(site.siteUrl)
    if (ids)
      ids.push(site.siteId)
    else
      byUrl.set(site.siteUrl, [site.siteId])
  }
  return sites.map(site => ({
    ...site,
    sameSiteUrlAs: (byUrl.get(site.siteUrl) ?? []).filter(id => id !== site.siteId).sort(),
  }) as FleetSummaryV1Site)
}

function sortMetricValue(
  site: Extract<FleetSummaryV1Site, { _tag: 'Ok' }>,
  sortBy: FleetSummarySortField,
): number | null {
  switch (sortBy) {
    case 'clicks':
      return site.totals.clicks
    case 'clicksDelta':
      return site.deltas?.clicks ?? null
    case 'clicksDeltaPct':
      return site.deltas?.clicksPct ?? null
    case 'impressions':
      return site.totals.impressions
    case 'impressionsDelta':
      return site.deltas?.impressions ?? null
    case 'impressionsDeltaPct':
      return site.deltas?.impressionsPct ?? null
    case 'positionDelta':
      return site.deltas?.position ?? null
  }
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareIdentity(a: FleetSummaryV1Site, b: FleetSummaryV1Site): number {
  const byUrl = compareCodePoint(a.siteUrl, b.siteUrl)
  return byUrl !== 0 ? byUrl : compareCodePoint(a.siteId, b.siteId)
}

/** Deterministic ADR-0027 sort: Ok rows by sortBy/sortDir (nulls last), then non-Ok rows by identity. */
export function sortFleetSummarySites(
  sites: readonly FleetSummaryV1Site[],
  sortBy: FleetSummarySortField,
  sortDir: FleetSummarySortDir,
): FleetSummaryV1Site[] {
  const dir = sortDir === 'asc' ? 1 : -1
  return [...sites].sort((a, b) => {
    const aOk = a._tag === 'Ok'
    const bOk = b._tag === 'Ok'
    if (aOk !== bOk)
      return aOk ? -1 : 1
    if (!aOk || !bOk)
      return compareIdentity(a, b)
    const aVal = sortMetricValue(a, sortBy)
    const bVal = sortMetricValue(b, sortBy)
    if (aVal == null && bVal == null)
      return compareIdentity(a, b)
    if (aVal == null)
      return 1
    if (bVal == null)
      return -1
    if (aVal !== bVal)
      return (aVal - bVal) * dir
    return compareIdentity(a, b)
  })
}

function coverageSpanDays(site: Extract<FleetSummaryV1Site, { _tag: 'Ok' }>): number {
  if (!site.coverage.startDate || !site.coverage.endDate)
    return 0
  const start = Date.parse(`${site.coverage.startDate}T00:00:00Z`)
  const end = Date.parse(`${site.coverage.endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return 0
  return Math.floor((end - start) / 86_400_000) + 1
}

/**
 * Choose one canonical Site per `siteUrl` for Fleet totals so two partner
 * registrations of the same host never double-count clicks or impressions.
 * Prefers `Ok` with complete coverage, then widest covered span, then newest sync.
 */
function pickCanonicalSiteForHost(group: readonly FleetSummaryV1Site[]): FleetSummaryV1Site {
  const ranked = [...group].sort((a, b) => {
    const rank = (s: FleetSummaryV1Site): number =>
      s._tag === 'Ok' ? 0 : s._tag === 'Empty' ? 1 : s._tag === 'NotSynced' ? 2 : 3
    const byTag = rank(a) - rank(b)
    if (byTag !== 0)
      return byTag
    if (a._tag === 'Ok' && b._tag === 'Ok') {
      if (a.coverage.complete !== b.coverage.complete)
        return a.coverage.complete ? -1 : 1
      const bySpan = coverageSpanDays(b) - coverageSpanDays(a)
      if (bySpan !== 0)
        return bySpan
      const aHasLegacy = Boolean(a.coverage.legacyHistory)
      const bHasLegacy = Boolean(b.coverage.legacyHistory)
      if (aHasLegacy !== bHasLegacy)
        return aHasLegacy ? 1 : -1
    }
    const aNewest = a.newestDateSynced ?? ''
    const bNewest = b.newestDateSynced ?? ''
    if (aNewest !== bNewest)
      return compareCodePoint(bNewest, aNewest)
    return compareCodePoint(a.siteId, b.siteId)
  })
  return ranked[0]!
}

function aggregateTotals(items: readonly FleetSummaryV1Totals[]): FleetSummaryV1Totals {
  let clicks = 0
  let impressions = 0
  let weightedPos = 0
  let posImpressions = 0
  for (const item of items) {
    clicks += item.clicks
    impressions += item.impressions
    if (item.position != null && item.impressions > 0) {
      weightedPos += item.position * item.impressions
      posImpressions += item.impressions
    }
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: posImpressions > 0 ? weightedPos / posImpressions : null,
  }
}

/** Deduplicate by `siteUrl` and mark `_tag: 'Partial'` whenever any unique host is unavailable or not synced. */
export function deduplicateFleetTotals(
  sites: readonly FleetSummaryV1Site[],
  hasComparison: boolean,
): FleetSummaryV1DeduplicatedTotals {
  const byUrl = new Map<string, FleetSummaryV1Site[]>()
  for (const site of sites) {
    const group = byUrl.get(site.siteUrl)
    if (group)
      group.push(site)
    else
      byUrl.set(site.siteUrl, [site])
  }

  const includedSiteIds: string[] = []
  const excludedDuplicateSiteIds: string[] = []
  const failedSiteIds: string[] = []
  const currentTotals: FleetSummaryV1Totals[] = []
  const previousTotals: FleetSummaryV1Totals[] = []

  for (const group of byUrl.values()) {
    const canonical = pickCanonicalSiteForHost(group)
    for (const member of group) {
      if (member.siteId !== canonical.siteId)
        excludedDuplicateSiteIds.push(member.siteId)
    }
    if (canonical._tag === 'Ok') {
      includedSiteIds.push(canonical.siteId)
      currentTotals.push(canonical.totals)
      if (canonical.previousTotals)
        previousTotals.push(canonical.previousTotals)
    }
    else if (canonical._tag === 'Empty') {
      includedSiteIds.push(canonical.siteId)
    }
    else {
      failedSiteIds.push(canonical.siteId)
    }
  }

  includedSiteIds.sort()
  excludedDuplicateSiteIds.sort()
  failedSiteIds.sort()

  const totals = aggregateTotals(currentTotals)
  // Emit Fleet comparison deltas only when every included Ok Site has comparison totals,
  // avoiding a mismatched numerator vs denominator across partial history.
  const allOkHavePrevious = currentTotals.length > 0 && previousTotals.length === currentTotals.length
  const prev = hasComparison && allOkHavePrevious ? aggregateTotals(previousTotals) : undefined
  const deltas = prev ? computeFleetDeltas(totals, prev) : undefined
  const _tag = failedSiteIds.length > 0 ? 'Partial' as const : 'Complete' as const

  return {
    _tag,
    uniqueSiteUrls: byUrl.size,
    includedSiteIds,
    excludedDuplicateSiteIds,
    failedSiteIds,
    totals,
    ...(prev ? { previousTotals: prev, deltas } : {}),
  }
}

/** Build a complete, canonically sorted and deduplicated Fleet summary payload. */
export function buildFleetSummary(input: BuildFleetSummaryInput): FleetSummaryV1Data {
  const linked = linkSameSiteUrls(input.sites)
  const sorted = sortFleetSummarySites(linked, input.sortBy, input.sortDir)
  const deduplicatedTotals = deduplicateFleetTotals(sorted, Boolean(input.window.comparison))
  return {
    window: input.window,
    searchType: input.searchType,
    sortBy: input.sortBy,
    sortDir: input.sortDir,
    sortFormula: fleetSummarySortFormula(input.sortBy, input.sortDir),
    sites: sorted,
    deduplicatedTotals,
  }
}
