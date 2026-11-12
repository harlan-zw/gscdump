// Index cohorts: which part of a Site does Google index worse than the rest?
//
// The statistics are ported from nuxtseo.com `layers/pro/gsc/shared/index-cohorts.ts`.
// The builder from inspected URLs is ported from request-indexing
// `layers/pro-indexing/shared/index-cohort-source.ts`, with its exact
// drill-through filter from `shared/contracts/index-cohorts.ts`.
//
// Google declines pages for structural reasons. Partitioning the inspected set
// and asking which partition Google treats differently names something a
// developer can act on. The load-bearing part is the refutation: a cohort is
// surfaced only when its Wilson score interval clears the rate of its own
// complement, never on a point estimate. Cohorts are compared against the
// complement, because a cohort that dominates the Site would otherwise be
// tested against a baseline that contains itself.
//
// Crawl depth and internal-link bands are not dimensions. Both failed a
// controlled test, and every extra dimension inflates the multiple-comparison
// correction.

import type { GscdumpIndexingUrl } from '@gscdump/contracts'

export interface IndexCohortPage {
  /** Site-relative path, such as `/docs/og-image/v5/guides/emojis`. */
  path: string
  /** Google reports this URL as indexed. */
  indexed: boolean
  inSitemap: boolean
}

export type IndexCohortDimension = 'section' | 'lifecycle'

export type IndexCohortLifecycle = 'versioned' | 'evergreen'

/** Exact Index cohort membership, for a URL list drill-through. */
export type IndexCohortFilter
  = | { dimension: 'section', key: string }
    | { dimension: 'lifecycle', key: IndexCohortLifecycle }

export interface IndexCohortCell {
  dimension: IndexCohortDimension
  /** A path prefix for `section`, a lifecycle tag for `lifecycle`. */
  key: string
  label: string
  /** The section prefix for presentation, or null for a lifecycle cohort. */
  pathPrefix: string | null
  total: number
  notIndexed: number
  /** Not-indexed share within the cohort. */
  rate: number
  /** Not-indexed share across every analysed page outside this cohort. */
  complementRate: number
  complementTotal: number
  ciLower: number
  ciUpper: number
  /**
   * How many of this cohort's not-indexed pages a higher-ranked cohort already
   * counts. Cohorts nest, so without this a reader adds 13 and 21 and believes
   * 34 pages are affected when 21 are.
   */
  overlapNotIndexed: number
}

export interface IndexCohortCoverage {
  /** Pages in the analysed set: the denominator. */
  analysed: number
  /** Inspected URLs dropped as `#fragment` anchors. They can never be indexed. */
  excludedFragments: number
  /** Inspected URLs a Crawl never reached. Always 0 when built from inspected URLs. */
  notCrawled: number
}

export interface IndexCohortBaseline {
  total: number
  notIndexed: number
  rate: number
}

export type IndexCohortDiagnosis
  = | { _tag: 'no-evidence', reason: 'no-inspection-join' | 'no-completed-crawl' }
    | { _tag: 'no-evidence', reason: 'sampled-index-state', enumerated: number, reported: number }
    | {
      _tag: 'uniform'
      baseline: IndexCohortBaseline
      coverage: IndexCohortCoverage
      /** The corrected critical value applied. */
      z: number
      tested: number
    }
    | {
      _tag: 'outliers'
      baseline: IndexCohortBaseline
      coverage: IndexCohortCoverage
      z: number
      tested: number
      /** Worst first. Only cohorts Google treats worse than their complement. */
      cells: IndexCohortCell[]
    }

interface IndexCohortsEnvelope {
  /** The Crawl settings behind the cohorts. Null when built from inspected URLs. */
  crawlSettingsId: number | null
  /** The caller's snapshot timestamp. */
  asOf: string | null
}

/** The Index cohorts wire shape nuxtseo.com and request-indexing publish. */
export type IndexCohortsResponse
  = | (IndexCohortsEnvelope & {
    _tag: 'no-evidence'
    reason: 'no-inspection-join' | 'no-completed-crawl' | 'sampled-index-state'
    /** Set only for `sampled-index-state`: the enumerated and reported not-indexed counts. */
    sample: { enumerated: number, reported: number } | null
  })
  | (IndexCohortsEnvelope & Extract<IndexCohortDiagnosis, { _tag: 'uniform' }>)
  | (IndexCohortsEnvelope & Extract<IndexCohortDiagnosis, { _tag: 'outliers' }>)

/**
 * The enumerated not-indexed list must cover at least this share of the count
 * gscdump reports. Below it the list is a sample, and every rate built on it
 * would treat the unlisted URLs as absent (nuxtseo.com #1306).
 */
export const COHORT_MIN_ENUMERATED_SHARE = 0.9

/** From this share of pages not indexed, no family can be an outlier: the failure covers the whole Site. */
export const SITE_WIDE_NOT_INDEXED_RATE = 0.5

/** Below this many pages, a cohort's interval is too wide for any claim. */
export const COHORT_MIN_CELL_SIZE = 12

/** Family-wise error rate, split across every cohort tested (Bonferroni). */
const COHORT_FAMILY_ALPHA = 0.05

/**
 * A version-scoped subtree: `/v5/` with a path after it. A trailing `/v6` is a
 * page about a version, not a version-pinned copy, so it stays out.
 */
const VERSION_SEGMENT = /\/v\d+\/.+/

const SECTION_KEY = /^\/(?:[^/?#]+(?:\/[^/?#]+)?)?$/

/** Message for the `sampled-index-state` reason, shared by every surface. */
export function sampledIndexStateMessage(enumerated: number, reported: number): string {
  return `Google index state is a sample: ${enumerated.toLocaleString('en-US')} of ${reported.toLocaleString('en-US')} not-indexed URLs. Family rates would be invented. Read the indexing summary instead.`
}

/**
 * Wilson score interval for a binomial proportion. The normal approximation
 * gives bounds outside 0 to 1 on small, skewed cohorts and zero width at p=0.
 */
export function wilsonInterval(successes: number, total: number, z: number): { lower: number, upper: number } {
  if (total <= 0)
    return { lower: 0, upper: 1 }
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const spread = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total))
  return {
    lower: Math.max(0, (centre - spread) / denominator),
    upper: Math.min(1, (centre + spread) / denominator),
  }
}

/**
 * Standard normal quantile (Acklam's rational approximation, error under
 * 1.15e-9). The corrected alpha varies with the cohort count, so the critical
 * value cannot be a fixed 1.96.
 */
function normalQuantile(p: number): number {
  if (p <= 0)
    return Number.NEGATIVE_INFINITY
  if (p >= 1)
    return Number.POSITIVE_INFINITY

  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}

/** Two-sided critical value for `tested` simultaneous comparisons. */
function criticalValue(tested: number): number {
  const alpha = COHORT_FAMILY_ALPHA / Math.max(1, tested)
  return Math.abs(normalQuantile(alpha / 2))
}

/**
 * Section keys at depth 1 and depth 2. A flat Site shatters at depth 2, and a
 * deep docs Site collapses at depth 1, so both are emitted and the size and
 * significance tests decide. `overlapNotIndexed` accounts for the nesting.
 */
function sectionKeys(path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0)
    return ['/']
  const depth1 = `/${segments[0]}`
  if (segments.length === 1)
    return [depth1]
  return [depth1, `/${segments.slice(0, 2).join('/')}`]
}

/**
 * `versioned` covers paths with an explicit version segment. Without a Site's
 * current version, supersession cannot be proven, only that the path is pinned.
 */
function lifecycleKey(path: string): IndexCohortLifecycle {
  return VERSION_SEGMENT.test(path) ? 'versioned' : 'evergreen'
}

/** True when the path belongs to the Index cohort the filter names. */
export function belongsToIndexCohort(path: string, filter: IndexCohortFilter): boolean {
  return filter.dimension === 'section'
    ? sectionKeys(path).includes(filter.key)
    : lifecycleKey(path) === filter.key
}

export type IndexCohortFilterParse
  = | { _tag: 'ok', filter: IndexCohortFilter }
    | { _tag: 'invalid', value: unknown }

/** Parse a `dimension:key` query value, such as `section:/docs` or `lifecycle:versioned`. */
export function parseIndexCohortFilter(value: unknown): IndexCohortFilterParse {
  if (typeof value !== 'string')
    return { _tag: 'invalid', value }
  const colon = value.indexOf(':')
  const dimension = value.slice(0, colon)
  const key = value.slice(colon + 1)
  if (colon > 0 && dimension === 'section' && SECTION_KEY.test(key))
    return { _tag: 'ok', filter: { dimension, key } }
  if (colon > 0 && dimension === 'lifecycle' && (key === 'versioned' || key === 'evergreen'))
    return { _tag: 'ok', filter: { dimension, key } }
  return { _tag: 'invalid', value }
}

/** The `dimension:key` query value of a cell, the inverse of `parseIndexCohortFilter`. */
export function indexCohortFilterValue(cell: Pick<IndexCohortCell, 'dimension' | 'key'>): string {
  return `${cell.dimension}:${cell.key}`
}

const LIFECYCLE_LABEL: Record<IndexCohortLifecycle, string> = {
  versioned: 'Version-pinned paths',
  evergreen: 'Unversioned paths',
}

interface Tally { total: number, notIndexed: number, notIndexedPaths: string[] }

/** A page may belong to several cells of one dimension (nested section depths). */
function tally(pages: ReadonlyArray<IndexCohortPage>, keysOf: (page: IndexCohortPage) => string[]): Map<string, Tally> {
  const out = new Map<string, Tally>()
  for (const page of pages) {
    for (const key of keysOf(page)) {
      const current = out.get(key) ?? { total: 0, notIndexed: 0, notIndexedPaths: [] }
      current.total += 1
      if (!page.indexed) {
        current.notIndexed += 1
        current.notIndexedPaths.push(page.path)
      }
      out.set(key, current)
    }
  }
  return out
}

export interface BuildIndexCohortInput {
  pages: ReadonlyArray<IndexCohortPage>
  excludedFragments: number
  notCrawled: number
}

/** Partition the analysed pages and keep only the cohorts Google treats worse than the rest of the Site. */
export function buildIndexCohortDiagnosis(input: BuildIndexCohortInput): IndexCohortDiagnosis {
  const { pages, excludedFragments, notCrawled } = input
  if (pages.length === 0)
    return { _tag: 'no-evidence', reason: 'no-inspection-join' }

  const notIndexed = pages.reduce((sum, page) => sum + (page.indexed ? 0 : 1), 0)
  const baseline: IndexCohortBaseline = { total: pages.length, notIndexed, rate: notIndexed / pages.length }
  const coverage: IndexCohortCoverage = { analysed: pages.length, excludedFragments, notCrawled }

  const dimensions: ReadonlyArray<{
    dimension: IndexCohortDimension
    tallies: Map<string, Tally>
    label: (key: string) => string
  }> = [
    { dimension: 'section', tallies: tally(pages, page => sectionKeys(page.path)), label: key => key },
    {
      dimension: 'lifecycle',
      tallies: tally(pages, page => [lifecycleKey(page.path)]),
      label: key => LIFECYCLE_LABEL[key as IndexCohortLifecycle] ?? key,
    },
  ]

  // Count every cell before testing any: the correction must reflect how many
  // chances the detector gave itself.
  const candidates = dimensions.flatMap(({ dimension, tallies, label }) =>
    [...tallies.entries()]
      .filter(([, cell]) => cell.total >= COHORT_MIN_CELL_SIZE && cell.total < pages.length)
      .map(([key, cell]) => ({ dimension, key, label: label(key), cell })),
  )

  const tested = candidates.length
  const z = criticalValue(tested)
  if (tested === 0)
    return { _tag: 'uniform', baseline, coverage, z, tested }

  const survivors: Array<{ cell: IndexCohortCell, notIndexedPaths: string[] }> = []
  for (const { dimension, key, label, cell } of candidates) {
    const complementTotal = baseline.total - cell.total
    const complementNotIndexed = baseline.notIndexed - cell.notIndexed
    const complementRate = complementTotal > 0 ? complementNotIndexed / complementTotal : 0
    const { lower, upper } = wilsonInterval(cell.notIndexed, cell.total, z)

    // The complement is the control, so it must be a usable one. A tiny
    // complement's rate is a coin flip, and testing against it manufactures
    // findings out of noise.
    if (complementTotal < COHORT_MIN_CELL_SIZE)
      continue

    // Only worse cohorts. A section Google indexes better is not a diagnosis.
    if (lower <= complementRate)
      continue

    survivors.push({
      notIndexedPaths: cell.notIndexedPaths,
      cell: {
        dimension,
        key,
        label,
        pathPrefix: dimension === 'section' ? key : null,
        total: cell.total,
        notIndexed: cell.notIndexed,
        rate: cell.notIndexed / cell.total,
        complementRate,
        complementTotal,
        ciLower: lower,
        ciUpper: upper,
        overlapNotIndexed: 0,
      },
    })
  }

  if (survivors.length === 0)
    return { _tag: 'uniform', baseline, coverage, z, tested }

  survivors.sort((left, right) =>
    (right.cell.rate - right.cell.complementRate) - (left.cell.rate - left.cell.complementRate)
    || right.cell.notIndexed - left.cell.notIndexed,
  )

  // Attribute each not-indexed page to the first (worst) cohort that claims it,
  // so the ranked list reads top-down without double counting.
  const claimed = new Set<string>()
  const cells = survivors.map(({ cell, notIndexedPaths }) => {
    const overlapNotIndexed = notIndexedPaths.reduce((sum, path) => sum + (claimed.has(path) ? 1 : 0), 0)
    for (const path of notIndexedPaths)
      claimed.add(path)
    return { ...cell, overlapNotIndexed }
  })

  return { _tag: 'outliers', baseline, coverage, z, tested, cells }
}

/**
 * One section's raw not-indexed tally, with no significance test. `established`
 * rides on every row, so a consumer cannot show the ranking without also
 * showing which rows passed the test.
 */
export interface IndexCohortSectionRank {
  /** Path prefix at depth 1 or 2: the same keys the tested cohorts use. */
  key: string
  total: number
  notIndexed: number
  /** Not-indexed share within the section. A point estimate, not a finding. */
  rate: number
  /** This section also passed the corrected significance test in the same run. */
  established: boolean
  /** Too few pages for any test (`COHORT_MIN_CELL_SIZE`). */
  belowMinimumSample: boolean
}

/** Every section ranked by not-indexed rate, worst first. Sections that span every page are dropped. */
export function rankIndexCohortSections(
  pages: ReadonlyArray<IndexCohortPage>,
  established: ReadonlyArray<IndexCohortCell> = [],
): IndexCohortSectionRank[] {
  const establishedKeys = new Set(
    established.filter(cell => cell.dimension === 'section').map(cell => cell.key),
  )
  return [...tally(pages, page => sectionKeys(page.path)).entries()]
    .filter(([, cell]) => cell.total < pages.length)
    .map(([key, cell]) => ({
      key,
      total: cell.total,
      notIndexed: cell.notIndexed,
      rate: cell.notIndexed / cell.total,
      established: establishedKeys.has(key),
      belowMinimumSample: cell.total < COHORT_MIN_CELL_SIZE,
    }))
    .sort((left, right) =>
      right.rate - left.rate
      || right.notIndexed - left.notIndexed
      || left.key.localeCompare(right.key),
    )
}

/** The lead derived from an Index cohort diagnosis. `none` says why there is no lead. */
export type IndexCohortLead
  = | { _tag: 'none', reason: 'no-evidence' | 'no-outlier' | 'site-wide' }
    | {
      _tag: 'lead'
      /** The noun and the number. */
      title: string
      /** The comparison that makes the title a diagnosis. */
      detail: string
      actionLabel: string
      cell: IndexCohortCell
    }

function cohortSubject(cell: IndexCohortCell): string {
  return cell.dimension === 'section'
    ? `pages under ${cell.key}`
    : 'version-pinned pages'
}

function asPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * Promote the worst cohort to the primary diagnosis. A located claim is more
 * actionable than a reason-led one. When no cohort separates, or most of the
 * Site is not indexed, there is no lead.
 */
export function selectIndexCohortLead(diagnosis: { _tag: 'no-evidence' } | Exclude<IndexCohortDiagnosis, { _tag: 'no-evidence' }>): IndexCohortLead {
  if (diagnosis._tag === 'no-evidence')
    return { _tag: 'none', reason: 'no-evidence' }
  if (diagnosis._tag === 'uniform')
    return { _tag: 'none', reason: 'no-outlier' }
  if (diagnosis.baseline.rate >= SITE_WIDE_NOT_INDEXED_RATE)
    return { _tag: 'none', reason: 'site-wide' }

  const cell = diagnosis.cells[0]
  if (!cell)
    return { _tag: 'none', reason: 'no-outlier' }

  return {
    _tag: 'lead',
    title: `${cell.notIndexed.toLocaleString('en-US')} of ${cell.total.toLocaleString('en-US')} ${cohortSubject(cell)} are missing from Google's index.`,
    detail: `That is ${asPercent(cell.rate)} not indexed, against ${asPercent(cell.complementRate)} across the rest of the site.`,
    actionLabel: `Review ${cell.notIndexed.toLocaleString('en-US')} ${cell.notIndexed === 1 ? 'URL' : 'URLs'}`,
    cell,
  }
}

/** One inspected URL row, as the hosted URLs read returns it. */
export type IndexCohortUrlRow = Pick<GscdumpIndexingUrl, 'url' | 'verdict'> & Partial<Pick<GscdumpIndexingUrl, 'sitemaps'>>

export interface IndexCohortSource<Row extends IndexCohortUrlRow = IndexCohortUrlRow> {
  urls: ReadonlyArray<Row>
  /** The Site URL the rows belong to, used to resolve relative rows. */
  siteUrl?: string | null
  /**
   * The not-indexed count gscdump reports for the Site: the diagnostics
   * `not_indexed` issue. 0 when the issue is absent.
   */
  reportedNotIndexed: number
}

/**
 * A row becomes a cohort page when it parses to an http or https URL with no
 * fragment. A `#anchor` URL can never be indexed on its own, so it counts as
 * excluded rather than distorting a section rate.
 */
type ParsedRow
  = | { _tag: 'page', page: IndexCohortPage, href: string }
    | { _tag: 'fragment' }
    | { _tag: 'unparsable' }

function siteOrigin(siteUrl: string | null | undefined): string | undefined {
  const site = siteUrl?.trim()
  if (!site)
    return undefined
  if (site.startsWith('sc-domain:'))
    return `https://${site.slice('sc-domain:'.length)}`
  return site.includes('://') ? site : `https://${site}`
}

function parseRow(row: IndexCohortUrlRow, siteUrl: string | null | undefined): ParsedRow {
  const candidate = row.url?.trim()
  if (!candidate)
    return { _tag: 'unparsable' }

  // Absolute rows do not depend on optional Site metadata.
  const base = siteOrigin(siteUrl)
  const parsed = URL.parse(candidate) ?? (base ? URL.parse(candidate, base) : null)
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
    return { _tag: 'unparsable' }
  if (parsed.hash)
    return { _tag: 'fragment' }

  return {
    _tag: 'page',
    href: parsed.href,
    page: {
      path: parsed.pathname,
      indexed: row.verdict === 'PASS',
      inSitemap: Array.isArray(row.sitemaps) ? row.sitemaps.length > 0 : false,
    },
  }
}

/**
 * Build the Index cohorts response from a complete set of inspected URLs. No
 * Crawl joins it, so `notCrawled` is 0 and `crawlSettingsId` is null. Below
 * `COHORT_MIN_ENUMERATED_SHARE` of the reported not-indexed count, the builder
 * refuses with `sampled-index-state` rather than rank sections.
 */
export function buildIndexCohortsFromIndexingUrls(source: IndexCohortSource, asOf: string | null = null): IndexCohortsResponse {
  const pages: IndexCohortPage[] = []
  const notIndexedUrls = new Set<string>()
  let excludedFragments = 0

  for (const row of source.urls) {
    const parsed = parseRow(row, source.siteUrl)
    if (parsed._tag === 'page') {
      pages.push(parsed.page)
      if (!parsed.page.indexed)
        notIndexedUrls.add(parsed.href)
    }
    else if (parsed._tag === 'fragment') {
      excludedFragments += 1
    }
  }

  const enumerated = notIndexedUrls.size
  const reported = source.reportedNotIndexed
  if (reported > 0 && enumerated / reported < COHORT_MIN_ENUMERATED_SHARE)
    return { _tag: 'no-evidence', crawlSettingsId: null, asOf, reason: 'sampled-index-state', sample: { enumerated, reported } }

  const diagnosis = buildIndexCohortDiagnosis({ pages, excludedFragments, notCrawled: 0 })
  if (diagnosis._tag === 'no-evidence')
    return { _tag: 'no-evidence', crawlSettingsId: null, asOf, reason: diagnosis.reason, sample: null }
  return { ...diagnosis, crawlSettingsId: null, asOf }
}

/** The not-indexed rows that belong to one Index cohort. */
export function selectIndexCohortUrls<Row extends IndexCohortUrlRow>(
  urls: ReadonlyArray<Row>,
  filter: IndexCohortFilter,
  siteUrl?: string | null,
): Row[] {
  return urls.filter((row) => {
    const parsed = parseRow(row, siteUrl)
    return parsed._tag === 'page' && !parsed.page.indexed && belongsToIndexCohort(parsed.page.path, filter)
  })
}
