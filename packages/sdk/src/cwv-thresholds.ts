// Core Web Vitals classification thresholds (Google's official cutoffs).
// `cwvBucket` returns 'good' | 'ni' (needs-improvement) | 'poor'.

export const CWV_GOOD_LCP = 2500
export const CWV_POOR_LCP = 4000
export const CWV_GOOD_INP = 200
export const CWV_POOR_INP = 500
export const CWV_GOOD_CLS = 0.1
export const CWV_POOR_CLS = 0.25

export type CwvBucket = 'good' | 'ni' | 'poor'

export function cwvBucket(metric: 'lcp' | 'inp' | 'cls', v: number): CwvBucket {
  if (metric === 'lcp')
    return v <= CWV_GOOD_LCP ? 'good' : v <= CWV_POOR_LCP ? 'ni' : 'poor'
  if (metric === 'inp')
    return v <= CWV_GOOD_INP ? 'good' : v <= CWV_POOR_INP ? 'ni' : 'poor'
  return v <= CWV_GOOD_CLS ? 'good' : v <= CWV_POOR_CLS ? 'ni' : 'poor'
}

/** Trim long query strings for table cells / chart tooltips. */
export function truncateQuery(q: string, max = 48): string {
  return q.length > max ? `${q.slice(0, max - 1)}…` : q
}

/** Best-effort extract a hostname; returns undefined if the URL is unparseable. */
export function siteUrlToHostname(url: string | undefined | null): string | undefined {
  if (!url)
    return undefined
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname
  }
  catch {
    return undefined
  }
}

/**
 * Split a title with `"quoted"` segments into highlight runs for inline
 * emphasis (e.g. opportunity cards rendering keywords in a stronger weight).
 */
export function splitOpportunityTitle(title: string): Array<{ text: string, highlight: boolean }> {
  return title.split(/("[^"]+")/g).filter(Boolean).map(part => ({
    text: part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
    highlight: part.startsWith('"') && part.endsWith('"'),
  }))
}
