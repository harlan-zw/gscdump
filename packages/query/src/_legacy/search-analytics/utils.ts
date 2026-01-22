import { withBase, withHttps } from 'ufo'

export function normalizePagePath(page: string, domain: string): string
export function normalizePagePath(page: string | null, domain: string): string | null
export function normalizePagePath(page: string | null, domain: string): string | null {
  if (!page)
    return page
  return page.replace('https://', '').replace(domain, '')
}

export function extractDomain(siteUrl: string): string {
  return siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function formatPageForQuery(page: string, siteUrl: string): string {
  let p = withBase(page, siteUrl)
  if (p === extractDomain(siteUrl))
    p = `${p}/`
  return withHttps(p)
}
