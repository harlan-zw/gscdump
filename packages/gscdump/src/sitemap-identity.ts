export type SitemapIdentityResult
  = | { _tag: 'ok', url: string }
    | { _tag: 'invalid', reason: 'credentials' | 'empty' | 'invalid_url' | 'off_origin' }

export interface SitemapEvidenceRecord {
  path: string
  lastDownloaded?: string | null
  fetchedAt?: number | null
}

export interface ScopedSitemapRecords<T extends SitemapEvidenceRecord> {
  sitemaps: Array<T & { path: string }>
  excludedCount: number
  duplicateCount: number
}

export interface SitemapContentEntry {
  loc: string
}

function normalizeSiteOrigin(input: string): string | null {
  const value = input.trim().replace(/^sc-domain:/i, '')
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    if (url.username || url.password)
      return null
    return url.origin
  }
  catch {
    return null
  }
}

export function canonicalSitemapIdentity(path: string, site = ''): SitemapIdentityResult {
  const value = path.trim()
  if (!value)
    return { _tag: 'invalid', reason: 'empty' }
  const siteOrigin = normalizeSiteOrigin(site)
  let parsed: URL
  try {
    parsed = new URL(value, siteOrigin ? `${siteOrigin}/` : undefined)
  }
  catch {
    return { _tag: 'invalid', reason: 'invalid_url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { _tag: 'invalid', reason: 'invalid_url' }
  if (parsed.username || parsed.password)
    return { _tag: 'invalid', reason: 'credentials' }
  if (siteOrigin && parsed.origin !== siteOrigin)
    return { _tag: 'invalid', reason: 'off_origin' }
  parsed.hash = ''
  return { _tag: 'ok', url: `${parsed.origin}${parsed.pathname}${parsed.search}` }
}

export function sameSitemapIdentity(left: string, right: string, site = ''): boolean {
  const leftIdentity = canonicalSitemapIdentity(left, site)
  if (leftIdentity._tag !== 'ok')
    return false
  const rightIdentity = canonicalSitemapIdentity(right, site)
  return rightIdentity._tag === 'ok' && leftIdentity.url === rightIdentity.url
}

function evidenceTime(record: SitemapEvidenceRecord): number {
  const downloadedAt = record.lastDownloaded ? Date.parse(record.lastDownloaded) : Number.NaN
  if (Number.isFinite(downloadedAt))
    return downloadedAt
  return record.fetchedAt ?? 0
}

export function scopeSitemapRecords<T extends SitemapEvidenceRecord>(
  records: readonly T[],
  site = '',
): ScopedSitemapRecords<T> {
  const byIdentity = new Map<string, T & { path: string }>()
  let excludedCount = 0
  let duplicateCount = 0
  for (const record of records) {
    const identity = canonicalSitemapIdentity(record.path, site)
    if (identity._tag !== 'ok') {
      excludedCount++
      continue
    }
    const normalized = { ...record, path: identity.url }
    const existing = byIdentity.get(identity.url)
    if (!existing) {
      byIdentity.set(identity.url, normalized)
      continue
    }
    duplicateCount++
    if (evidenceTime(normalized) >= evidenceTime(existing))
      byIdentity.set(identity.url, normalized)
  }
  return {
    sitemaps: [...byIdentity.values()],
    excludedCount,
    duplicateCount,
  }
}

/**
 * Versioned exact membership digest. This deliberately does not use the
 * analytics-only `urlMatchKey` normalizer.
 */
export async function sitemapContentHash(entries: readonly SitemapContentEntry[]): Promise<string> {
  const locs = [...new Set(entries.map(entry => entry.loc))].sort()
  const input = new TextEncoder().encode(locs.join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', input)
  const hex = Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
  return `v1:${hex}`
}
