import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalSitemapIdentity,
  discoverSitemap,
  discoverSitemapResult,
  fetchSitemapDocument,
  fetchSitemapUrls,
  parseSitemapDocument,
  sameSitemapIdentity,
  scopeSitemapRecords,
  walkSitemaps,
} from '../src/sitemap'

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2026-07-20</lastmod></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`

function response(body: BodyInit, init?: ResponseInit): Response {
  return new Response(body, { status: 200, ...init })
}

describe('parseSitemapDocument', () => {
  it('strictly parses namespaced URL entries and decodes XML entities', async () => {
    await expect(parseSitemapDocument(URLSET)).resolves.toEqual({
      _tag: 'urlset',
      entries: [
        { loc: 'https://example.com/a?x=1&y=2', lastmod: '2026-07-20' },
        { loc: 'https://example.com/b' },
      ],
      meta: {
        bytesRead: new TextEncoder().encode(URLSET).byteLength,
        complete: true,
        hasBom: false,
        hasXmlDeclaration: true,
        namespace: 'http://www.sitemaps.org/schemas/sitemap/0.9',
      },
    })
  })

  it('keeps extension loc elements scoped to their extension records', async () => {
    const result = await parseSitemapDocument(`<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
        <url>
          <loc>https://example.com/page</loc>
          <image:image>
            <image:loc>https://example.com/image.jpg</image:loc>
          </image:image>
        </url>
      </urlset>`)
    expect(result).toMatchObject({
      _tag: 'urlset',
      entries: [{ loc: 'https://example.com/page' }],
    })
  })

  it('fails closed on malformed XML', async () => {
    const result = await parseSitemapDocument('<urlset><url><loc>https://example.com</urlset>')
    expect(result._tag).toBe('parse_error')
  })

  it('returns bounded partial entries with explicit completeness', async () => {
    const result = await parseSitemapDocument(URLSET, { maxEntries: 1 })
    expect(result).toMatchObject({
      _tag: 'urlset',
      entries: [{ loc: 'https://example.com/a?x=1&y=2' }],
      meta: { complete: false },
    })
  })

  it('applies URL filters before the accepted-entry cap', async () => {
    const result = await parseSitemapDocument(
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/api/one</loc></url>
        <url><loc>https://example.com/one</loc></url>
        <url><loc>https://example.com/api/two</loc></url>
        <url><loc>https://example.com/two</loc></url>
        <url><loc>https://example.com/three</loc></url>
      </urlset>`,
      {
        maxEntries: 2,
        acceptUrl: entry => !entry.loc.includes('/api/'),
      },
    )
    expect(result).toMatchObject({
      _tag: 'urlset',
      entries: [
        { loc: 'https://example.com/one' },
        { loc: 'https://example.com/two' },
      ],
      meta: { complete: false },
    })
  })

  it('classifies HTML and byte-limit failures', async () => {
    await expect(parseSitemapDocument('<html><head><meta http-equiv="refresh" content="0; url=/real.xml"></head></html>'))
      .resolves
      .toEqual({ _tag: 'html', metaRefreshUrl: '/real.xml' })
    await expect(parseSitemapDocument(URLSET, { maxBytes: 10 }))
      .resolves
      .toMatchObject({ _tag: 'byte_limit', maxBytes: 10 })
  })
})

describe('fetchSitemapDocument', () => {
  it('detects and decompresses a raw gzip body', async () => {
    const fetcher = vi.fn(async () => response(gzipSync(URLSET)))
    const result = await fetchSitemapDocument('https://example.com/sitemap.xml.gz', { fetcher })
    expect(result._tag).toBe('ok')
    if (result._tag !== 'ok')
      return
    expect(result.document._tag).toBe('urlset')
    expect(result.document.entries[0]).toEqual({
      loc: 'https://example.com/a?x=1&y=2',
      lastmod: '2026-07-20',
    })
  })
})

describe('discoverSitemap', () => {
  it('rejects HTML shells and follows every robots.txt sitemap directive', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/sitemap.xml'))
        return response('<html>shell</html>')
      if (url.endsWith('/sitemap_index.xml') || url.endsWith('/sitemap-index.xml') || url.endsWith('/sitemaps.xml'))
        return new Response('', { status: 404 })
      if (url.endsWith('/robots.txt')) {
        return response(`User-agent: *
Sitemap: https://cdn.example.com/first.xml
Sitemap: https://cdn.example.com/real.xml`)
      }
      if (url.endsWith('/first.xml'))
        return new Response('', { status: 410 })
      return response(URLSET)
    })

    await expect(discoverSitemapResult('example.com', { fetcher })).resolves.toEqual({
      _tag: 'found',
      url: 'https://cdn.example.com/real.xml',
      source: 'robots',
    })
  })

  it('distinguishes incomplete discovery from an authoritative miss', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/robots.txt'))
        throw new Error('DNS failure')
      return new Response('', { status: 404 })
    })
    const result = await discoverSitemapResult('example.com', { fetcher })
    expect(result).toMatchObject({
      _tag: 'incomplete',
      failures: [{ kind: 'network', detail: 'DNS failure' }],
    })
  })

  it('preserves the package-root string-or-null discovery contract', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/sitemap.xml')
        ? response(URLSET)
        : new Response('', { status: 404 }))
    await expect(discoverSitemap('example.com', { fetcher }))
      .resolves
      .toBe('https://example.com/sitemap.xml')
  })
})

describe('fetchSitemapUrls compatibility', () => {
  it('returns URL strings and observes the legacy limit', async () => {
    const fetcher = vi.fn(async () => response(URLSET))
    await expect(fetchSitemapUrls('https://example.com/sitemap.xml', {
      fetcher,
      limit: 1,
    })).resolves.toEqual(['https://example.com/a?x=1&y=2'])
  })
})

describe('walkSitemaps', () => {
  it('treats missing alternative roots as authoritative absence, not truncation', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/missing.xml')
        ? new Response('', { status: 404 })
        : response(URLSET))
    await expect(walkSitemaps([
      'https://example.com/missing.xml',
      'https://example.com/sitemap.xml',
    ], { fetcher })).resolves.toMatchObject({
      _tag: 'ok',
      complete: true,
      documentsRead: 1,
    })
  })

  it('walks an index, preserves lastmod, and deduplicates URLs', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/index.xml')) {
        return response(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/first.xml</loc></sitemap>
          <sitemap><loc>https://example.com/second.xml</loc></sitemap>
        </sitemapindex>`)
      }
      if (url.endsWith('/first.xml'))
        return response(URLSET)
      return response('<urlset><url><loc>https://example.com/b</loc></url><url><loc>https://example.com/c</loc><lastmod>2026-07-21</lastmod></url></urlset>')
    })

    await expect(walkSitemaps('https://example.com/index.xml', { fetcher })).resolves.toEqual({
      _tag: 'ok',
      complete: true,
      documentsRead: 3,
      failures: [],
      entries: [
        { loc: 'https://example.com/a?x=1&y=2', lastmod: '2026-07-20' },
        { loc: 'https://example.com/b' },
        { loc: 'https://example.com/c', lastmod: '2026-07-21' },
      ],
    })
  })

  it('marks URL-cap walks incomplete and skips remaining documents', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/index.xml')) {
        return response('<sitemapindex><sitemap><loc>https://example.com/first.xml</loc></sitemap><sitemap><loc>https://example.com/never.xml</loc></sitemap></sitemapindex>')
      }
      return response(URLSET)
    })
    const result = await walkSitemaps('https://example.com/index.xml', { fetcher, maxUrls: 1 })
    expect(result).toMatchObject({
      _tag: 'ok',
      complete: false,
      entries: [{ loc: 'https://example.com/a?x=1&y=2' }],
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('sitemap identity', () => {
  it('canonicalizes relative records, excludes off-origin evidence, and keeps the newest duplicate', () => {
    const result = scopeSitemapRecords([
      { path: '/sitemap.xml', fetchedAt: 1 },
      { path: 'https://example.com/sitemap.xml#fragment', fetchedAt: 2 },
      { path: 'https://other.example/sitemap.xml', fetchedAt: 3 },
    ], 'sc-domain:example.com')
    expect(result).toEqual({
      sitemaps: [{ path: 'https://example.com/sitemap.xml', fetchedAt: 2 }],
      excludedCount: 1,
      duplicateCount: 1,
    })
    expect(canonicalSitemapIdentity('javascript:alert(1)', 'example.com'))
      .toEqual({ _tag: 'invalid', reason: 'invalid_url' })
    expect(sameSitemapIdentity('/sitemap.xml', 'https://example.com/sitemap.xml', 'example.com')).toBe(true)
  })
})
