// The Markdown copy of a portfolio indexing view, for pasting into an LLM.
//
// Ported from nuxtseo.com `layers/pro/gsc/app/utils/indexingGrowthExport.ts`.
// The on-screen table stays scannable. This builds a denser payload, with
// display granularity and copy granularity decoupled on purpose.

import type { Period } from '../period'

/** One day of a Site's exported trend. */
export interface IndexingMarkdownTrendPoint {
  date: string
  /** Indexed share at this point, 0 to 100. */
  indexedPercent: number
  /** Crawl errors at this point: not found, soft 404, and server errors. */
  errors: number
}

export interface IndexingMarkdownIssues {
  notFound: number
  soft404: number
  serverError: number
}

export interface IndexingMarkdownSite {
  name: string
  hostname: string
  hasGsc: boolean
  /** The Site reading at the window end. */
  indexed: number | null
  totalUrls: number | null
  indexedPercent: number | null
  /** Indexed share change over 7 days, in percentage points. */
  change7d: number | null
  /** Indexed share change over 28 days, in percentage points. */
  change28d: number | null
  /** The window's daily series. */
  trend: IndexingMarkdownTrendPoint[] | null
  /** Crawl errors from the reading at the window end. */
  latestIssues: IndexingMarkdownIssues | null
}

export interface IndexingMarkdownInput {
  title: string
  periodLabel: string
  range: { start: string, end: string } | null
  sites: IndexingMarkdownSite[]
}

export interface IndexingMarkdownBucket {
  start: string
  end: string
  /** Mean indexed share across the bucket's days. */
  indexedPercent: number
  /** Summed errors across the bucket's days. */
  errors: number
}

// Rolling, equal-length bucket size in days per preset Period, so each Period
// yields about 4 to 13 points. Custom ranges fall back to weekly.
const BUCKET_DAYS: Readonly<Record<string, number>> = {
  '7d': 1,
  '28d': 7,
  '3m': 7,
  '6m': 14,
  '12m': 30,
}

/** Days per exported bucket for a Period. */
export function indexingMarkdownBucketDays(period: Period | string): number {
  return Object.hasOwn(BUCKET_DAYS, period) ? BUCKET_DAYS[period]! : 7
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000)
}

/**
 * Bucket a daily series into rolling equal-length windows anchored to the most
 * recent date, so the latest bucket is always full. The indexed share is the
 * bucket mean; errors are summed. Oldest first.
 */
export function bucketIndexingSeries(trend: readonly IndexingMarkdownTrendPoint[], bucketDays: number): IndexingMarkdownBucket[] {
  if (!trend.length)
    return []
  const sorted = trend.toSorted((a, b) => a.date.localeCompare(b.date))
  const maxDay = dayNumber(sorted.at(-1)!.date)
  const groups = new Map<number, IndexingMarkdownTrendPoint[]>()
  for (const point of sorted) {
    const index = Math.floor((maxDay - dayNumber(point.date)) / bucketDays)
    const group = groups.get(index) ?? []
    group.push(point)
    groups.set(index, group)
  }
  // Index 0 is the most recent window. Emit oldest first for a left-to-right read.
  return [...groups.keys()].sort((a, b) => b - a).map((index) => {
    const points = groups.get(index)!
    return {
      start: points[0]!.date,
      end: points.at(-1)!.date,
      indexedPercent: points.reduce((sum, point) => sum + point.indexedPercent, 0) / points.length,
      errors: points.reduce((sum, point) => sum + point.errors, 0),
    }
  })
}

// Merge per-Site daily series into one Portfolio series: the mean indexed share
// across the Sites reporting that day, and their summed errors.
function mergeTrend(sites: readonly IndexingMarkdownSite[]): IndexingMarkdownTrendPoint[] {
  const days = new Map<string, { percentSum: number, percentCount: number, errors: number }>()
  for (const site of sites) {
    for (const point of site.trend ?? []) {
      const day = days.get(point.date) ?? { percentSum: 0, percentCount: 0, errors: 0 }
      day.percentSum += point.indexedPercent
      day.percentCount += 1
      day.errors += point.errors
      days.set(point.date, day)
    }
  }
  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, day]) => ({ date, indexedPercent: day.percentSum / day.percentCount, errors: day.errors }))
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function signed(value: number, digits: number, suffix = ''): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`
}

function issuesLabel(issues: IndexingMarkdownIssues | null): string {
  if (!issues)
    return 'n/a'
  const total = issues.notFound + issues.soft404 + issues.serverError
  if (total === 0)
    return '0'
  const parts: string[] = []
  if (issues.notFound)
    parts.push(`not-found ${formatCount(issues.notFound)}`)
  if (issues.soft404)
    parts.push(`soft-404 ${formatCount(issues.soft404)}`)
  if (issues.serverError)
    parts.push(`server-error ${formatCount(issues.serverError)}`)
  return `${formatCount(total)} (${parts.join(', ')})`
}

function trendTable(buckets: readonly IndexingMarkdownBucket[]): string {
  const lines = [
    '| Period | Indexed % | Errors |',
    '| --- | ---: | ---: |',
  ]
  for (const bucket of buckets)
    lines.push(`| ${bucket.start} → ${bucket.end} | ${bucket.indexedPercent.toFixed(1)}% | ${formatCount(bucket.errors)} |`)
  return lines.join('\n')
}

function siteSummary(site: IndexingMarkdownSite): string {
  const lines: string[] = []
  if (site.indexed != null && site.totalUrls != null) {
    const percent = site.indexedPercent != null ? ` (${site.indexedPercent.toFixed(1)}%)` : ''
    lines.push(`Indexed: ${formatCount(site.indexed)} / ${formatCount(site.totalUrls)}${percent}`)
  }
  const deltas: string[] = []
  if (site.change7d != null)
    deltas.push(`Δ 7d ${signed(site.change7d, 1, ' points')}`)
  if (site.change28d != null)
    deltas.push(`Δ 28d ${signed(site.change28d, 1, ' points')}`)
  if (deltas.length)
    lines.push(deltas.join('   '))
  lines.push(`Errors: ${issuesLabel(site.latestIssues)}`)
  return lines.join('\n')
}

const SCOPE_NOTE = 'Scope: registered host only, subdomains excluded. Source: Google Search Console URL Inspection / coverage.'
const METHOD_NOTE = 'Buckets are rolling and equal-length, oldest first. Indexed % is the mean across the bucket\'s days; errors are summed.'

/**
 * The Markdown indexing payload for a set of Sites. With one Site (a row copy)
 * the Portfolio table is skipped; with many (a Portfolio copy) it leads. Sites
 * without indexing data are dropped, and the Markdown says how many.
 */
export function buildIndexingPortfolioMarkdown(input: IndexingMarkdownInput, period: Period | string): string {
  const sites = input.sites.filter(site => site.hasGsc && site.trend && site.trend.length)
  const bucketDays = indexingMarkdownBucketDays(period)
  const out: string[] = [`# Indexing coverage: ${input.title}`]
  const range = input.range ? ` (${input.range.start} → ${input.range.end})` : ''
  out.push(`Period: ${input.periodLabel}${range}.`)
  out.push(SCOPE_NOTE)
  out.push(METHOD_NOTE)
  if (sites.length < input.sites.length)
    out.push(`Coverage: ${sites.length} of ${input.sites.length} sites have indexing data; the rest are omitted.`)
  out.push('')

  if (!sites.length) {
    out.push('_No indexing data available for the selected period._')
    return `${out.join('\n').trim()}\n`
  }

  if (sites.length > 1) {
    let indexed = 0
    let total = 0
    for (const site of sites) {
      indexed += site.indexed ?? 0
      total += site.totalUrls ?? 0
    }
    out.push(`## Portfolio (${sites.length} sites)`)
    out.push(`Indexed: ${formatCount(indexed)} / ${formatCount(total)}${total > 0 ? ` (${((indexed / total) * 100).toFixed(1)}%)` : ''}`)
    out.push('')
    out.push(trendTable(bucketIndexingSeries(mergeTrend(sites), bucketDays)))
    out.push('')
  }

  for (const site of sites) {
    const label = site.hostname && site.hostname !== site.name ? `${site.name} (${site.hostname})` : site.name
    out.push(`## ${label}`)
    out.push(siteSummary(site))
    out.push('')
    out.push(trendTable(bucketIndexingSeries(site.trend!, bucketDays)))
    out.push('')
  }

  return `${out.join('\n').trim()}\n`
}
