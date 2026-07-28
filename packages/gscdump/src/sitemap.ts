import type { SitemapUrlInput } from '@nuxtjs/sitemap/utils'
import { parseSitemapStream } from '@nuxtjs/sitemap/utils'
import { urlMatchKey } from './url'

const DEFAULT_FETCH_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 50_000
const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_DOCUMENTS = 100
const SNIFF_BYTES = 65_536
const COMMON_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemaps.xml',
] as const

export interface SitemapUrlEntry {
  loc: string
  lastmod?: string
  changefreq?: string
  priority?: number
}

export interface SitemapIndexEntry {
  loc: string
  lastmod?: string
}

export interface SitemapDocumentMeta {
  bytesRead: number
  complete: boolean
  hasBom: boolean
  hasXmlDeclaration: boolean
  namespace: string | null
}

export type SitemapDocumentResult
  = | { _tag: 'urlset', entries: SitemapUrlEntry[], meta: SitemapDocumentMeta }
    | { _tag: 'index', entries: SitemapIndexEntry[], meta: SitemapDocumentMeta }
    | { _tag: 'empty_body' }
    | { _tag: 'html', metaRefreshUrl?: string }
    | { _tag: 'byte_limit', bytesRead: number, maxBytes: number }
    | { _tag: 'parse_error', error: string }
    | { _tag: 'unsupported_document', root: string | null }

export interface ParseSitemapDocumentOptions {
  maxBytes?: number
  maxEntries?: number
  acceptUrl?: (entry: SitemapUrlEntry) => boolean
}

export type SitemapBody
  = | string
    | Uint8Array
    | ReadableStream<Uint8Array>
    | AsyncIterable<Uint8Array>

export interface SitemapFetchOptions extends ParseSitemapDocumentOptions {
  fetcher?: typeof fetch
  headers?: HeadersInit
  signal?: AbortSignal
  timeoutMs?: number
}

export type SitemapFetchResult
  = | { _tag: 'ok', url: string, document: Extract<SitemapDocumentResult, { _tag: 'urlset' | 'index' }> }
    | { _tag: 'not_found', url: string, status: 404 | 410 }
    | { _tag: 'http_error', url: string, status: number, statusText: string }
    | { _tag: 'network_error', url: string, error: string }
    | { _tag: 'document_error', url: string, error: Exclude<SitemapDocumentResult, { _tag: 'urlset' | 'index' }> }

export interface DiscoverSitemapOptions extends SitemapFetchOptions {
  userAgent?: string
}

export interface SitemapDiscoveryFailure {
  url: string
  kind: 'http' | 'network' | 'document'
  detail: string
}

export type SitemapDiscoveryResult
  = | { _tag: 'found', url: string, source: 'common_path' | 'robots' }
    | { _tag: 'not_found' }
    | { _tag: 'incomplete', failures: SitemapDiscoveryFailure[] }

export interface WalkSitemapsOptions extends SitemapFetchOptions {
  maxDepth?: number
  maxDocuments?: number
  maxUrls?: number
}

export interface FetchSitemapUrlsOptions extends DiscoverSitemapOptions {
  maxDepth?: number
  limit?: number
}

export interface SitemapWalkFailure {
  url: string
  depth: number
  error: Exclude<SitemapFetchResult, { _tag: 'ok' }>
}

export type SitemapWalkResult
  = | {
    _tag: 'ok'
    entries: SitemapUrlEntry[]
    documentsRead: number
    complete: boolean
    failures: SitemapWalkFailure[]
  }
  | { _tag: 'not_found' }
  | { _tag: 'error', failures: SitemapWalkFailure[] }

export type SitemapIdentityResult
  = | { _tag: 'ok', url: string }
    | { _tag: 'invalid', reason: 'empty' | 'invalid_url' | 'off_origin' }

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function looksLikeHtml(prefix: string): boolean {
  const start = prefix
    .trimStart()
    .replace(/^\uFEFF/, '')
    .replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '')
  return /^<!doctype\s+html\b|^<html\b/i.test(start)
}

function extractMetaRefreshUrl(html: string): string | undefined {
  return /content=["']?\d+;\s*url=([^"'\s>]+)/i.exec(html)?.[1]
}

function isAsyncIterable(value: SitemapBody): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value
}

async function* readableStreamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let done = false
  try {
    while (!done) {
      const next = await reader.read()
      done = next.done
      if (next.value)
        yield next.value
    }
  }
  finally {
    if (!done)
      await reader.cancel('sitemap reader stopped before the response body completed')
  }
}

async function* bodyChunks(body: SitemapBody): AsyncGenerator<Uint8Array> {
  if (typeof body === 'string') {
    yield new TextEncoder().encode(body)
    return
  }
  if (body instanceof Uint8Array) {
    yield body
    return
  }
  if (isAsyncIterable(body)) {
    yield* body
    return
  }
  yield* readableStreamChunks(body)
}

function replayStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initial: Uint8Array[],
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset < initial.length) {
        controller.enqueue(initial[offset++]!)
        return
      }
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      if (next.value)
        controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

async function bodyWithDetectedCompression(
  body: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader()
  const initial: Uint8Array[] = []
  let prefixLength = 0
  while (prefixLength < 2) {
    const next = await reader.read()
    if (next.done)
      break
    if (next.value) {
      initial.push(next.value)
      prefixLength += next.value.byteLength
    }
  }
  const prefix = initial.length === 1
    ? initial[0]!
    : Uint8Array.from(initial.flatMap(chunk => [...chunk]))
  const replay = replayStream(reader, initial)
  const gzip = prefix.length >= 2 && prefix[0] === 0x1F && prefix[1] === 0x8B
  if (!gzip)
    return replay
  if (typeof DecompressionStream === 'undefined') {
    await replay.cancel('gzip decompression is unavailable in this runtime')
    throw new Error('gzip sitemap body requires DecompressionStream support')
  }
  return replay.pipeThrough(
    new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  )
}

interface SitemapInputStats {
  bytesRead: number
  prefix: string
  hasContent: boolean
  hasBom: boolean
}

type PreparedSitemapInput
  = | { _tag: 'ready', input: AsyncIterable<Uint8Array>, stats: SitemapInputStats }
    | { _tag: 'empty_body' }
    | { _tag: 'html', metaRefreshUrl?: string }
    | { _tag: 'byte_limit', bytesRead: number, maxBytes: number }

interface SitemapInputBoundaryError extends Error {
  _tag: 'byte_limit'
  bytesRead: number
  maxBytes: number
}

function sitemapInputBoundaryError(bytesRead: number, maxBytes: number): SitemapInputBoundaryError {
  return Object.assign(
    new Error(`Sitemap exceeds ${maxBytes} bytes`),
    { _tag: 'byte_limit' as const, bytesRead, maxBytes },
  )
}

function isSitemapInputBoundaryError(error: unknown): error is SitemapInputBoundaryError {
  return error !== null
    && typeof error === 'object'
    && '_tag' in error
    && error._tag === 'byte_limit'
}

async function* replaySitemapInput(
  initial: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
  stats: SitemapInputStats,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let done = false
  try {
    yield* initial
    while (!done) {
      const next = await iterator.next()
      done = Boolean(next.done)
      if (!next.value)
        continue
      const bytesRead = stats.bytesRead + next.value.byteLength
      if (bytesRead > maxBytes)
        throw sitemapInputBoundaryError(bytesRead, maxBytes)
      stats.bytesRead = bytesRead
      yield next.value
    }
  }
  finally {
    if (!done)
      await iterator.return?.(undefined)
  }
}

async function prepareSitemapInput(
  body: SitemapBody,
  maxBytes: number,
): Promise<PreparedSitemapInput> {
  const iterator = bodyChunks(body)[Symbol.asyncIterator]()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const initial: Uint8Array[] = []
  const stats: SitemapInputStats = {
    bytesRead: 0,
    prefix: '',
    hasContent: false,
    hasBom: false,
  }
  let done = false

  while (stats.prefix.length < SNIFF_BYTES && !done) {
    const next = await iterator.next()
    done = Boolean(next.done)
    if (!next.value)
      continue
    const bytesRead = stats.bytesRead + next.value.byteLength
    if (bytesRead > maxBytes) {
      await iterator.return?.(undefined)
      return { _tag: 'byte_limit', bytesRead, maxBytes }
    }
    initial.push(next.value)
    stats.bytesRead = bytesRead
    const text = decoder.decode(next.value, { stream: true })
    stats.prefix += text.slice(0, SNIFF_BYTES - stats.prefix.length)
  }
  if (done && stats.prefix.length < SNIFF_BYTES)
    stats.prefix += decoder.decode()

  stats.hasContent = Boolean(stats.prefix.trim())
  stats.hasBom = stats.prefix.charCodeAt(0) === 0xFEFF
  if (!stats.hasContent) {
    await iterator.return?.(undefined)
    return { _tag: 'empty_body' }
  }
  if (looksLikeHtml(stats.prefix)) {
    await iterator.return?.(undefined)
    const metaRefreshUrl = extractMetaRefreshUrl(stats.prefix)
    return { _tag: 'html', ...(metaRefreshUrl ? { metaRefreshUrl } : {}) }
  }

  return {
    _tag: 'ready',
    input: replaySitemapInput(initial, iterator, stats, maxBytes),
    stats,
  }
}

function normalizeSitemapUrlInput(input: SitemapUrlInput): SitemapUrlEntry | null {
  if (typeof input === 'string')
    return { loc: input }
  if (!input.loc)
    return null
  const lastmod = input.lastmod instanceof Date ? input.lastmod.toISOString() : input.lastmod
  return {
    loc: input.loc,
    ...(lastmod ? { lastmod } : {}),
    ...(input.changefreq ? { changefreq: input.changefreq } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  }
}

function rootMetadata(prefix: string): { root: string | null, namespace: string | null } {
  const rootMatch = /<(?:[\w.-]+:)?(urlset|sitemapindex)\b([^>]*)>/i.exec(prefix)
  if (!rootMatch) {
    const anyRoot = /<(?:[\w.-]+:)?([\w.-]+)\b/.exec(prefix)
    return { root: anyRoot?.[1]?.toLowerCase() ?? null, namespace: null }
  }
  const attributes = rootMatch[2] ?? ''
  const namespace = /\sxmlns(?::[\w.-]+)?=(["'])(.*?)\1/i.exec(attributes)?.[2] ?? null
  return { root: rootMatch[1]!.toLowerCase(), namespace }
}

/**
 * Streaming sitemap parser backed by the same utility Nuxt Sitemap consumers
 * previously used. Expected failures are tagged values.
 * Entry limits produce a useful partial document with `meta.complete = false`;
 * byte limits fail closed because the document boundary was not observed.
 */
export async function parseSitemapDocument(
  body: SitemapBody,
  options: ParseSitemapDocumentOptions = {},
): Promise<SitemapDocumentResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const prepared = await prepareSitemapInput(body, maxBytes)
  if (prepared._tag !== 'ready')
    return prepared

  let root: string | null = null
  let complete = true
  const urls: SitemapUrlEntry[] = []
  const sitemaps: SitemapIndexEntry[] = []

  try {
    for await (const event of parseSitemapStream(prepared.input)) {
      if (event._tag === 'kind') {
        root = event.kind === 'index' ? 'sitemapindex' : 'urlset'
        continue
      }
      if (event._tag === 'warning')
        continue
      if (event._tag === 'url') {
        const entry = normalizeSitemapUrlInput(event.url)
        if (!entry || (options.acceptUrl && !options.acceptUrl(entry)))
          continue
        if (urls.length >= maxEntries) {
          complete = false
          break
        }
        urls.push(entry)
      }
      else if (event._tag === 'sitemap') {
        if (sitemaps.length >= maxEntries) {
          complete = false
          break
        }
        sitemaps.push(event.sitemap)
      }
      if (!complete)
        break
    }
  }
  catch (error) {
    if (isSitemapInputBoundaryError(error))
      return error
    const metadata = rootMetadata(prepared.stats.prefix)
    if (metadata.root && metadata.root !== 'urlset' && metadata.root !== 'sitemapindex')
      return { _tag: 'unsupported_document', root: metadata.root }
    return { _tag: 'parse_error', error: `Not a valid sitemap: ${errorMessage(error)}` }
  }

  const metadata = rootMetadata(prepared.stats.prefix)
  const meta: SitemapDocumentMeta = {
    bytesRead: prepared.stats.bytesRead,
    complete,
    hasBom: prepared.stats.hasBom,
    hasXmlDeclaration: /^\s*<\?xml\b/i.test(prepared.stats.prefix),
    namespace: metadata.namespace,
  }
  if (root === 'urlset')
    return { _tag: 'urlset', entries: urls, meta }
  if (root === 'sitemapindex')
    return { _tag: 'index', entries: sitemaps, meta }
  return { _tag: 'unsupported_document', root }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (signal)
    return signal
  return AbortSignal.timeout(timeoutMs)
}

export async function fetchSitemapDocument(
  url: string,
  options: SitemapFetchOptions = {},
): Promise<SitemapFetchResult> {
  const fetcher = options.fetcher ?? globalThis.fetch
  let response: Response
  try {
    response = await fetcher(url, {
      headers: {
        accept: 'application/xml,text/xml,application/rss+xml,*/*;q=0.1',
        ...options.headers,
      },
      redirect: 'follow',
      signal: requestSignal(options.signal, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
    })
  }
  catch (error) {
    return { _tag: 'network_error', url, error: errorMessage(error) }
  }

  if (response.status === 404 || response.status === 410)
    return { _tag: 'not_found', url, status: response.status }
  if (!response.ok)
    return { _tag: 'http_error', url, status: response.status, statusText: response.statusText }
  if (!response.body)
    return { _tag: 'document_error', url, error: { _tag: 'empty_body' } }

  let body: ReadableStream<Uint8Array>
  try {
    body = await bodyWithDetectedCompression(response.body)
  }
  catch (error) {
    return { _tag: 'document_error', url, error: { _tag: 'parse_error', error: errorMessage(error) } }
  }
  const document = await parseSitemapDocument(body, options)
  if (document._tag === 'urlset' || document._tag === 'index')
    return { _tag: 'ok', url: response.url || url, document }
  return { _tag: 'document_error', url, error: document }
}

export function parseRobotsSitemapUrls(robots: string, baseUrl?: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
    const raw = match[1]
    if (!raw)
      continue
    let value = raw
    if (baseUrl) {
      try {
        value = new URL(raw, baseUrl).toString()
      }
      catch {
        continue
      }
    }
    if (!seen.has(value)) {
      seen.add(value)
      urls.push(value)
    }
  }
  return urls
}

function normalizeSiteOrigin(input: string): string | null {
  const value = input.trim().replace(/^sc-domain:/i, '')
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
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

function discoveryFailure(result: Exclude<SitemapFetchResult, { _tag: 'ok' | 'not_found' }>): SitemapDiscoveryFailure {
  if (result._tag === 'network_error')
    return { url: result.url, kind: 'network', detail: result.error }
  if (result._tag === 'http_error')
    return { url: result.url, kind: 'http', detail: `HTTP ${result.status}: ${result.statusText}` }
  return { url: result.url, kind: 'document', detail: result.error._tag }
}

async function readRobots(
  origin: string,
  options: DiscoverSitemapOptions,
): Promise<{ urls: string[], failure?: SitemapDiscoveryFailure }> {
  const url = `${origin}/robots.txt`
  const fetcher = options.fetcher ?? globalThis.fetch
  let response: Response
  try {
    response = await fetcher(url, {
      headers: { 'user-agent': options.userAgent ?? 'gscdump sitemap fetcher' },
      signal: requestSignal(options.signal, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
    })
  }
  catch (error) {
    return { urls: [], failure: { url, kind: 'network', detail: errorMessage(error) } }
  }
  if (response.status === 404 || response.status === 410)
    return { urls: [] }
  if (!response.ok) {
    return {
      urls: [],
      failure: { url, kind: 'http', detail: `HTTP ${response.status}: ${response.statusText}` },
    }
  }
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 1024 * 1024)
  const body = response.body
  if (!body)
    return { urls: [] }
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for await (const chunk of readableStreamChunks(body)) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        return {
          urls: [],
          failure: { url, kind: 'document', detail: `robots.txt exceeds ${maxBytes} bytes` },
        }
      }
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
  }
  catch (error) {
    return { urls: [], failure: { url, kind: 'network', detail: errorMessage(error) } }
  }
  return { urls: parseRobotsSitemapUrls(text, origin) }
}

/**
 * Discover a real sitemap document. A 200 HTML shell is rejected, and
 * transport failures remain distinguishable from an authoritative miss.
 */
export async function discoverSitemapResult(
  site: string,
  options: DiscoverSitemapOptions = {},
): Promise<SitemapDiscoveryResult> {
  const origin = normalizeSiteOrigin(site)
  if (!origin) {
    return {
      _tag: 'incomplete',
      failures: [{ url: site, kind: 'document', detail: 'invalid site URL' }],
    }
  }
  const headers = {
    'user-agent': options.userAgent ?? 'gscdump sitemap fetcher',
    ...options.headers,
  }
  const failures: SitemapDiscoveryFailure[] = []
  for (const path of COMMON_SITEMAP_PATHS) {
    const url = `${origin}${path}`
    const result = await fetchSitemapDocument(url, { ...options, headers })
    if (result._tag === 'ok')
      return { _tag: 'found', url: result.url, source: 'common_path' }
    if (result._tag !== 'not_found' && !(result._tag === 'document_error' && (result.error._tag === 'html' || result.error._tag === 'unsupported_document')))
      failures.push(discoveryFailure(result))
  }

  const robots = await readRobots(origin, options)
  if (robots.failure)
    failures.push(robots.failure)
  for (const url of robots.urls) {
    const result = await fetchSitemapDocument(url, { ...options, headers })
    if (result._tag === 'ok')
      return { _tag: 'found', url: result.url, source: 'robots' }
    if (result._tag !== 'not_found')
      failures.push(discoveryFailure(result))
  }

  return failures.length > 0 ? { _tag: 'incomplete', failures } : { _tag: 'not_found' }
}

/**
 * Compatibility surface retained at the package root. New callers that need
 * explicit incomplete-discovery evidence should use `discoverSitemapResult`.
 */
export async function discoverSitemap(
  site: string,
  options: DiscoverSitemapOptions = {},
): Promise<string | null> {
  const result = await discoverSitemapResult(site, options)
  return result._tag === 'found' ? result.url : null
}

function walkFailure(
  url: string,
  depth: number,
  error: Exclude<SitemapFetchResult, { _tag: 'ok' }>,
): SitemapWalkFailure {
  return { url, depth, error }
}

/**
 * Bounded sitemap and sitemap-index walk. Partial results are explicit through
 * `complete` and `failures`; callers must not infer removals from an incomplete
 * walk.
 */
export async function walkSitemaps(
  roots: string | readonly string[],
  options: WalkSitemapsOptions = {},
): Promise<SitemapWalkResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS
  const maxUrls = options.maxUrls ?? DEFAULT_MAX_ENTRIES
  const queue = (typeof roots === 'string' ? [roots] : [...roots]).map(url => ({ url, depth: 0 }))
  const rootCount = queue.length
  const seenDocuments = new Set<string>()
  const seenUrls = new Set<string>()
  const entries: SitemapUrlEntry[] = []
  const failures: SitemapWalkFailure[] = []
  let documentsRead = 0
  let complete = true
  let loadedRoot = false
  let missingRoots = 0

  while (queue.length > 0) {
    if (documentsRead >= maxDocuments) {
      complete = false
      break
    }
    const next = queue.shift()!
    if (seenDocuments.has(next.url))
      continue
    seenDocuments.add(next.url)
    const result = await fetchSitemapDocument(next.url, {
      ...options,
      maxEntries: Math.max(maxUrls - entries.length, 1),
    })
    if (result._tag !== 'ok') {
      if (next.depth === 0 && result._tag === 'not_found') {
        missingRoots++
        continue
      }
      else {
        failures.push(walkFailure(next.url, next.depth, result))
      }
      complete = false
      continue
    }
    if (next.depth === 0)
      loadedRoot = true
    documentsRead++
    complete &&= result.document.meta.complete

    if (result.document._tag === 'index') {
      if (next.depth >= maxDepth && result.document.entries.length > 0) {
        complete = false
        continue
      }
      for (const child of result.document.entries)
        queue.push({ url: child.loc, depth: next.depth + 1 })
      continue
    }

    for (const entry of result.document.entries) {
      if (seenUrls.has(entry.loc))
        continue
      if (entries.length >= maxUrls) {
        complete = false
        break
      }
      seenUrls.add(entry.loc)
      entries.push(entry)
    }
    if (entries.length >= maxUrls && queue.length > 0) {
      complete = false
      break
    }
  }

  if (!loadedRoot && missingRoots === rootCount && failures.length === 0)
    return { _tag: 'not_found' }
  if (!loadedRoot)
    return { _tag: 'error', failures }
  return { _tag: 'ok', entries, documentsRead, complete, failures }
}

function legacyWalkFailureMessage(failure: SitemapWalkFailure): string {
  const result = failure.error
  if (result._tag === 'not_found' || result._tag === 'http_error')
    return `Fetch ${failure.url} failed: ${result.status}`
  if (result._tag === 'network_error')
    return result.error
  if (result.error._tag === 'parse_error')
    return result.error.error
  return `Sitemap ${failure.url} failed: ${result.error._tag}`
}

/**
 * Compatibility surface retained at the package root. The shared parser and
 * traversal own the work while the original string-array contract remains.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: FetchSitemapUrlsOptions = {},
): Promise<string[]> {
  const {
    limit,
    maxDepth,
    userAgent,
    ...fetchOptions
  } = options
  const result = await walkSitemaps(sitemapUrl, {
    ...fetchOptions,
    headers: {
      'user-agent': userAgent ?? 'gscdump sitemap fetcher',
      ...fetchOptions.headers,
    },
    maxDepth,
    maxDocuments: Number.MAX_SAFE_INTEGER,
    maxUrls: limit ?? Number.MAX_SAFE_INTEGER,
  })
  if (result._tag === 'not_found')
    throw new Error(`Fetch ${sitemapUrl} failed: 404`)
  if (result._tag === 'error')
    throw new Error(result.failures[0] ? legacyWalkFailureMessage(result.failures[0]) : 'Sitemap fetch failed')
  if (result.failures[0])
    throw new Error(legacyWalkFailureMessage(result.failures[0]))
  return result.entries.map(entry => entry.loc)
}

export async function sitemapContentHash(entries: readonly Pick<SitemapUrlEntry, 'loc'>[]): Promise<string> {
  const normalized = entries
    .map(entry => urlMatchKey(entry.loc))
    .filter((url): url is string => Boolean(url))
    .sort()
  const input = new TextEncoder().encode(normalized.join('\n'))
  const hash = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
