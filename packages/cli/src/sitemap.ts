import type { SitemapReadResult, SitemapWalkOptions } from 'sitemapd'
import { createSitemapReader, parseRobotsSitemaps } from 'sitemapd'
import { createFetchDocumentLoader } from 'sitemapd/fetch'

const COMMON_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemaps.xml',
] as const

export interface LoadedSitemapUrls {
  urls: string[]
  /** The same URLs with the `lastmod` each feed declares. */
  entries: Array<{ loc: string, lastmod?: string }>
  complete: boolean
  documentsRead: number
}

export type LoadSitemapUrlsResult
  = | { _tag: 'ok', value: LoadedSitemapUrls }
    | { _tag: 'error', message: string }

export type DiscoverLiveSitemapResult
  = | { _tag: 'found', url: string, source: 'common_path' | 'robots' }
    | { _tag: 'not_found' }
    | { _tag: 'incomplete', failures: string[] }

function publicHttpTarget(url: string): { _tag: 'allow' } | { _tag: 'deny', reason: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    return { _tag: 'deny', reason: 'invalid URL' }
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? { _tag: 'allow' }
    : { _tag: 'deny', reason: 'only HTTP(S) sitemap targets are supported' }
}

function createLiveReader(fetch: typeof globalThis.fetch = globalThis.fetch): ReturnType<typeof createSitemapReader> {
  return createSitemapReader({
    loadDocument: createFetchDocumentLoader({ fetch }),
    authorizeTarget: ({ url }) => publicHttpTarget(url),
  })
}

function readFailure(result: Exclude<SitemapReadResult, { _tag: 'ok' }>): string {
  if (result._tag === 'not_found')
    return `${result.url}: HTTP ${result.status}`
  return `${result.url}: ${result.code ?? result.reason}: ${result.detail}`
}

export async function loadSitemapUrls(
  url: string,
  options: SitemapWalkOptions = {},
): Promise<LoadSitemapUrlsResult> {
  const result = await createLiveReader().walk(url, options)
  if (result.documentsRead === 0) {
    return {
      _tag: 'error',
      message: result.failures[0]
        ? readFailure(result.failures[0].result)
        : 'No sitemap document was found',
    }
  }
  return {
    _tag: 'ok',
    value: {
      urls: result.entries.map(entry => entry.loc),
      entries: result.entries.map(entry => entry.lastmod === undefined
        ? { loc: entry.loc }
        : { loc: entry.loc, lastmod: entry.lastmod }),
      complete: result._tag === 'complete',
      documentsRead: result.documentsRead,
    },
  }
}

export async function discoverLiveSitemap(
  input: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<DiscoverLiveSitemapResult> {
  let origin: string
  try {
    origin = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).origin
  }
  catch {
    return { _tag: 'incomplete', failures: [`${input}: invalid site URL`] }
  }
  const reader = createLiveReader(fetch)
  const failures: string[] = []
  for (const path of COMMON_PATHS) {
    const result = await reader.read(`${origin}${path}`)
    if (result._tag === 'ok')
      return { _tag: 'found', url: result.url, source: 'common_path' }
    if (result._tag !== 'not_found' && !(result._tag === 'failure' && result.reason === 'document'))
      failures.push(readFailure(result))
  }

  const robotsUrl = `${origin}/robots.txt`
  const robots = await fetch(robotsUrl, { redirect: 'manual' })
    .then(async response => response.ok ? response.text() : '')
    .catch((error: unknown) => {
      failures.push(`${robotsUrl}: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    })
  for (const reference of parseRobotsSitemaps(robots, robotsUrl)) {
    const result = await reader.read(reference.loc)
    if (result._tag === 'ok')
      return { _tag: 'found', url: result.url, source: 'robots' }
    if (result._tag !== 'not_found')
      failures.push(readFailure(result))
  }
  return failures.length > 0 ? { _tag: 'incomplete', failures } : { _tag: 'not_found' }
}
