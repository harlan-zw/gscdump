import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSitemapUrls } from '../src/sitemap'

function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200 })
}

describe('fetchSitemapUrls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deduplicates URL entries while preserving their first-seen order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => xmlResponse(`
      <urlset>
        <url><loc> https://example.com/a </loc></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>https://example.com/a</loc></url>
      </urlset>
    `)))

    await expect(fetchSitemapUrls('https://example.com/sitemap.xml')).resolves.toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ])
  })

  it('stops parsing and fetching nested sitemap entries once the limit is met', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.endsWith('/index.xml')) {
        return xmlResponse(`
          <sitemapindex>
            <sitemap><loc>https://example.com/first.xml</loc></sitemap>
            <sitemap><loc>https://example.com/never-fetched.xml</loc></sitemap>
          </sitemapindex>
        `)
      }
      return xmlResponse(`
        <urlset>
          <url><loc>https://example.com/one</loc></url>
          <url><loc>https://example.com/two</loc></url>
        </urlset>
      `)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSitemapUrls('https://example.com/index.xml', { limit: 1 })).resolves.toEqual([
      'https://example.com/one',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalledWith('https://example.com/never-fetched.xml', expect.anything())
  })
})
