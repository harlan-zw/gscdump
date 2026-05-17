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
