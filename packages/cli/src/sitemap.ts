import type { SitemapWalkResult, WalkSitemapsOptions } from 'gscdump/sitemap'
import { walkSitemaps } from 'gscdump/sitemap'

export interface LoadedSitemapUrls {
  urls: string[]
  complete: boolean
  documentsRead: number
}

export type LoadSitemapUrlsResult
  = | { _tag: 'ok', value: LoadedSitemapUrls }
    | { _tag: 'error', message: string }

function failureMessage(result: Exclude<SitemapWalkResult, { _tag: 'ok' }>): string {
  if (result._tag === 'not_found')
    return 'No sitemap document was found'
  const first = result.failures[0]
  if (!first)
    return 'Sitemap walk failed before reading a document'
  const error = first.error
  if (error._tag === 'network_error')
    return `${first.url}: ${error.error}`
  if (error._tag === 'http_error')
    return `${first.url}: HTTP ${error.status} ${error.statusText}`
  if (error._tag === 'not_found')
    return `${first.url}: HTTP ${error.status}`
  return `${first.url}: ${error.error._tag}`
}

export async function loadSitemapUrls(
  url: string,
  options: WalkSitemapsOptions = {},
): Promise<LoadSitemapUrlsResult> {
  const result = await walkSitemaps(url, options)
  if (result._tag !== 'ok')
    return { _tag: 'error', message: failureMessage(result) }
  return {
    _tag: 'ok',
    value: {
      urls: result.entries.map(entry => entry.loc),
      complete: result.complete,
      documentsRead: result.documentsRead,
    },
  }
}
