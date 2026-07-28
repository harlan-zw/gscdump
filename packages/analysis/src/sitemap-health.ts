// Pure delta + totals for sitemap-health daily snapshots. Storage wiring
// (read prev row, write next row) stays in the host app; this only computes
// the deltas + aggregated totals against the canonical GSC sitemap shape.

export interface SitemapHealthRow {
  path: string
  errors: number
  warnings: number
}

export interface SitemapHealthInput extends SitemapHealthRow {
  isPending?: boolean
  type?: string
  contents?: Array<{ submitted: number | string }>
}

export interface SitemapDelta {
  path: string
  errorDelta: number
  warningDelta: number
  newErrors: number
  newWarnings: number
}

export interface SitemapHealthTotals {
  totalSitemaps: number
  totalUrls: number
  totalErrors: number
  totalWarnings: number
  pendingCount: number
  indexSitemaps: number
}

export interface SitemapHealthDiff {
  changed: boolean
  deltas: SitemapDelta[]
  totals: SitemapHealthTotals
}

export interface SitemapCollapsePolicy {
  ratio: number
  minHighWater: number
  minDrop: number
  baselineOffset: 1 | 2
}

export const SITEMAP_SYNC_COLLAPSE_POLICY: SitemapCollapsePolicy = {
  ratio: 0.5,
  minHighWater: 10,
  minDrop: 10,
  baselineOffset: 1,
}

export const SITEMAP_TRUST_COLLAPSE_POLICY: SitemapCollapsePolicy = {
  ratio: 0.2,
  minHighWater: 20,
  minDrop: 0,
  baselineOffset: 2,
}

export type SitemapCollapseState
  = | { _tag: 'none' }
    | {
      _tag: 'awaiting_confirmation' | 'persisted' | 'recovered_blip'
      current: number
      highWater: number
    }

export interface CurrentSitemapScope {
  current: number
  highWater: number
  collapsed: boolean
}

function isCollapsed(count: number, highWater: number, policy: SitemapCollapsePolicy): boolean {
  return highWater >= policy.minHighWater
    && count < highWater * policy.ratio
    && highWater - count >= policy.minDrop
}

export function classifySitemapCollapse(
  newestFirstCounts: ReadonlyArray<number | null | undefined>,
  policy: SitemapCollapsePolicy,
): SitemapCollapseState {
  if (newestFirstCounts.length <= policy.baselineOffset)
    return { _tag: 'none' }
  const current = Math.max(0, newestFirstCounts[0] ?? 0)
  const previous = Math.max(0, newestFirstCounts[1] ?? 0)
  const highWater = Math.max(
    0,
    ...newestFirstCounts.slice(policy.baselineOffset).map(value => Math.max(0, value ?? 0)),
  )
  if (isCollapsed(current, highWater, policy)) {
    return {
      _tag: isCollapsed(previous, highWater, policy) ? 'persisted' : 'awaiting_confirmation',
      current,
      highWater,
    }
  }
  if (isCollapsed(previous, highWater, policy))
    return { _tag: 'recovered_blip', current, highWater }
  return { _tag: 'none' }
}

export function compareCurrentSitemapScope(
  newestFirstCounts: ReadonlyArray<number | null | undefined>,
  policy: SitemapCollapsePolicy,
): CurrentSitemapScope | null {
  if (newestFirstCounts.length < 2)
    return null
  const current = Math.max(0, newestFirstCounts[0] ?? 0)
  const highWater = Math.max(
    0,
    ...newestFirstCounts.slice(1).map(value => Math.max(0, value ?? 0)),
  )
  return { current, highWater, collapsed: isCollapsed(current, highWater, policy) }
}

export function sitemapHistoryHasCollapse(
  newestFirstCounts: ReadonlyArray<number | null | undefined>,
  policy: SitemapCollapsePolicy,
): boolean {
  let highWater = 0
  for (const raw of newestFirstCounts.toReversed()) {
    const count = Math.max(0, raw ?? 0)
    if (isCollapsed(count, highWater, policy))
      return true
    highWater = Math.max(highWater, count)
  }
  return false
}

function urlCountOf(sitemap: SitemapHealthInput): number {
  return sitemap.contents?.reduce((sum, c) => sum + (Number(c.submitted) || 0), 0) || 0
}

export function diffSitemapHealth(
  prev: readonly SitemapHealthRow[],
  curr: readonly SitemapHealthInput[],
): SitemapHealthDiff {
  const previousByPath = new Map(prev.map(r => [r.path, r]))
  const deltas: SitemapDelta[] = []
  let changed = false

  for (const sitemap of curr) {
    const prior = previousByPath.get(sitemap.path)
    const errorDelta = prior ? sitemap.errors - (prior.errors || 0) : 0
    const warningDelta = prior ? sitemap.warnings - (prior.warnings || 0) : 0
    if (errorDelta !== 0 || warningDelta !== 0) {
      changed = true
      deltas.push({
        path: sitemap.path,
        errorDelta,
        warningDelta,
        newErrors: sitemap.errors,
        newWarnings: sitemap.warnings,
      })
    }
  }

  const totals: SitemapHealthTotals = {
    totalSitemaps: curr.length,
    totalUrls: curr.reduce((sum, s) => sum + urlCountOf(s), 0),
    totalErrors: curr.reduce((sum, s) => sum + s.errors, 0),
    totalWarnings: curr.reduce((sum, s) => sum + s.warnings, 0),
    pendingCount: curr.filter(s => s.isPending).length,
    indexSitemaps: curr.filter(s => s.type === 'sitemapIndex').length,
  }

  return { changed, deltas, totals }
}
