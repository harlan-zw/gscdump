import type { BingFetch, BingUrlInfoWire } from '../../src/bing'
import { describe, expect, it, vi } from 'vitest'
import {
  bingWebmaster,
  normalizeBingIndexingEvidence,
  normalizeBingUrlInfo,
} from '../../src/bing'

const clock = () => new Date('2026-08-11T13:35:27.000Z')

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })
}

function queuedFetch(...responses: Response[]): BingFetch {
  return vi.fn(async () => {
    const response = responses.shift()
    if (!response)
      throw new Error('Unexpected request')
    return response
  })
}

const urlInfoWire = {
  __type: 'UrlInfo:#Microsoft.Bing.Webmaster.Api',
  AnchorCount: 298,
  DiscoveryDate: '/Date(1688713200000-0700)/',
  DocumentSize: 367800,
  HttpStatus: 0,
  IsPage: true,
  LastCrawledDate: '/Date(1786440051000)/',
  TotalChildUrlCount: 0,
  Url: 'https://nuxtseo.com/',
} satisfies BingUrlInfoWire

describe('bingWebmaster', () => {
  it('lists Sites through the OAuth bearer boundary', async () => {
    const fetch = queuedFetch(json({ d: [{
      AuthenticationCode: 'private-code',
      DnsVerificationCode: 'private-code.example.com',
      IsVerified: true,
      Url: 'https://nuxtseo.com/',
    }] }))
    const client = bingWebmaster({ accessToken: 'access-token', clock, fetch })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: true, value: [{
      isVerified: true,
      url: 'https://nuxtseo.com/',
    }] })
    const [input, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(input)).toBe('https://www.bing.com/webmaster/api.svc/json/GetUserSites')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token')
  })

  it('uses an injected base URL', async () => {
    const fetch = queuedFetch(json({ d: [] }))
    const client = bingWebmaster({
      accessToken: 'access-token',
      baseUrl: 'https://bing.test/api/',
      clock,
      fetch,
    })

    await client.getUserSites()

    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe('https://bing.test/api/GetUserSites')
  })

  it('returns AuthenticationRequired before a request when the token is empty', async () => {
    const fetch = vi.fn() as unknown as BingFetch
    const client = bingWebmaster({ accessToken: ' ', clock, fetch })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: { _tag: 'AuthenticationRequired' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'AuthenticationRequired'],
    [403, 'PermissionDenied'],
  ] as const)('maps HTTP %s to %s', async (status, tag) => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ Message: 'rejected' }, status)),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: { _tag: tag } })
  })

  it('keeps a blocked Bing user distinct from Site permission loss', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ ErrorCode: 6, Message: 'user blocked' }, 403)),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: { _tag: 'UserBlocked' } })
  })

  it('maps throttling and preserves Retry-After', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ ErrorCode: 4, Message: 'slow down' }, 429, { 'retry-after': '7' })),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: {
      _tag: 'Throttled',
      retryAfterMs: 7000,
    } })
  })

  it('maps HTTP 503 to provider unavailability', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ Message: 'quota unavailable' }, 503)),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: { _tag: 'ProviderUnavailable', status: 503 } })
  })

  it('keeps other 5xx failures distinct', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ Message: 'failed' }, 500)),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: {
      _tag: 'ProviderUnavailable',
      status: 500,
    } })
  })

  it('returns MalformedResponse for invalid JSON', async () => {
    const fetch = queuedFetch(new Response('{', { status: 200 }))
    const client = bingWebmaster({ accessToken: 'access-token', clock, fetch })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: {
      _tag: 'MalformedResponse',
      operation: 'GetUserSites',
      reason: 'invalid-json',
    } })
  })

  it('uses the HTTP status when an error body is not JSON', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(new Response('', { status: 401 })),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: { _tag: 'AuthenticationRequired' } })
  })

  it('returns MalformedResponse for a wrong response shape', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [{ IsVerified: 'yes', Url: 4 }] })),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: {
      _tag: 'MalformedResponse',
      operation: 'GetUserSites',
      reason: 'invalid-payload',
    } })
  })

  it('returns UnverifiedSite from the verified Site lookup', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [{
        AuthenticationCode: '',
        DnsVerificationCode: '',
        IsVerified: false,
        Url: 'https://nuxtseo.com/',
      }] })),
    })

    const result = await client.getVerifiedSite('https://nuxtseo.com/')

    expect(result).toEqual({ ok: false, error: {
      _tag: 'UnverifiedSite',
      siteUrl: 'https://nuxtseo.com/',
    } })
  })

  it('returns SiteUnavailable when the Site is absent', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [] })),
    })

    const result = await client.getVerifiedSite('https://nuxtseo.com/')

    expect(result).toEqual({ ok: false, error: {
      _tag: 'SiteUnavailable',
      siteUrl: 'https://nuxtseo.com/',
    } })
  })

  it('preserves rejected request details', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ ErrorCode: 8, Message: 'invalid Site' }, 400)),
    })

    const result = await client.getUserSites()

    expect(result).toEqual({ ok: false, error: {
      _tag: 'RequestRejected',
      errorCode: 8,
      message: 'invalid Site',
      status: 400,
    } })
  })

  it('gets and normalizes independent URL dates', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: urlInfoWire })),
    })

    const result = await client.getUrlInfo('https://nuxtseo.com/', 'https://nuxtseo.com/')

    expect(result).toEqual({ ok: true, value: {
      anchorCount: 298,
      discoveryDate: '2023-07-07T07:00:00.000Z',
      documentSize: 367800,
      httpStatus: 0,
      isPage: true,
      lastCrawledDate: '2026-08-11T09:20:51.000Z',
      totalChildUrlCount: 0,
      url: 'https://nuxtseo.com/',
    } })
  })

  it('removes Bing year-one sentinel dates', () => {
    const result = normalizeBingUrlInfo({
      ...urlInfoWire,
      DiscoveryDate: '/Date(-62135568000000-0800)/',
      LastCrawledDate: '/Date(-62135568000000-0800)/',
    })

    expect(result).toEqual({ ok: true, value: {
      anchorCount: 298,
      documentSize: 367800,
      httpStatus: 0,
      isPage: true,
      totalChildUrlCount: 0,
      url: 'https://nuxtseo.com/',
    } })
  })

  it('accepts omitted provider dates', () => {
    const { DiscoveryDate: _discovery, LastCrawledDate: _crawled, ...wire } = urlInfoWire

    const result = normalizeBingUrlInfo(wire)

    expect(result.ok && result.value.discoveryDate).toBeUndefined()
    expect(result.ok && result.value.lastCrawledDate).toBeUndefined()
  })

  it('returns unknown Indexing Evidence when Bing has no URL response', () => {
    const result = normalizeBingIndexingEvidence(null, 'https://nuxtseo.com/new', clock())

    expect(result).toEqual({ ok: true, value: {
      _tag: 'UnknownEvidence',
      observedAt: '2026-08-11T13:35:27.000Z',
      reason: 'not-observed',
      searchEngine: 'bing',
      url: 'https://nuxtseo.com/new',
    } })
  })

  it('normalizes a URL response to crawl Indexing Evidence', () => {
    const urlInfo = normalizeBingUrlInfo(urlInfoWire)
    if (!urlInfo.ok)
      throw new Error('fixture must parse')

    const result = normalizeBingIndexingEvidence(urlInfo.value, urlInfo.value.url, clock())

    expect(result).toEqual({ ok: true, value: {
      _tag: 'CrawlEvidence',
      anchorCount: 298,
      discoveryDate: '2023-07-07T07:00:00.000Z',
      documentSize: 367800,
      httpStatus: 0,
      lastCrawledDate: '2026-08-11T09:20:51.000Z',
      observedAt: '2026-08-11T13:35:27.000Z',
      rawStatus: 0,
      searchEngine: 'bing',
      totalChildUrlCount: 0,
      uncertaintyReason: 'indexed-verdict-unavailable',
      url: 'https://nuxtseo.com/',
    } })
  })

  it('treats Bing populated zero objects as unknown evidence', () => {
    const url = 'https://nuxtseo.com/new'
    const urlInfo = normalizeBingUrlInfo({
      ...urlInfoWire,
      AnchorCount: 0,
      DiscoveryDate: '/Date(-62135568000000-0800)/',
      DocumentSize: 0,
      HttpStatus: 0,
      LastCrawledDate: '/Date(-62135568000000-0800)/',
      TotalChildUrlCount: 0,
      Url: url,
    })
    if (!urlInfo.ok)
      throw new Error('fixture must parse')

    const result = normalizeBingIndexingEvidence(urlInfo.value, url, clock())

    expect(result).toEqual({ ok: true, value: {
      _tag: 'UnknownEvidence',
      observedAt: '2026-08-11T13:35:27.000Z',
      reason: 'not-discovered',
      searchEngine: 'bing',
      url,
    } })
  })

  it('keeps a zero object with a crawl date as crawl evidence', () => {
    const url = 'https://nuxtseo.com/demo'
    const urlInfo = normalizeBingUrlInfo({
      ...urlInfoWire,
      AnchorCount: 0,
      DiscoveryDate: '/Date(-62135568000000-0800)/',
      DocumentSize: 0,
      HttpStatus: 0,
      LastCrawledDate: '/Date(1783119531000)/',
      TotalChildUrlCount: 0,
      Url: url,
    })
    if (!urlInfo.ok)
      throw new Error('fixture must parse')

    const result = normalizeBingIndexingEvidence(urlInfo.value, url, clock())

    expect(result.ok && result.value._tag).toBe('CrawlEvidence')
  })

  it('gets Indexing Evidence with the injected clock', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: urlInfoWire })),
    })

    const result = await client.getIndexingEvidence('https://nuxtseo.com/', 'https://nuxtseo.com/')

    expect(result.ok && result.value.observedAt).toBe('2026-08-11T13:35:27.000Z')
  })

  it('maps a null URL response to unknown evidence', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: null })),
    })

    const result = await client.getIndexingEvidence(
      'https://nuxtseo.com/',
      'https://nuxtseo.com/new',
    )

    expect(result.ok && result.value._tag).toBe('UnknownEvidence')
  })

  it('rejects directory responses as unsupported URL evidence', () => {
    const urlInfo = normalizeBingUrlInfo({ ...urlInfoWire, IsPage: false })
    if (!urlInfo.ok)
      throw new Error('fixture must parse')

    const result = normalizeBingIndexingEvidence(urlInfo.value, urlInfo.value.url, clock())

    expect(result).toEqual({ ok: false, error: {
      _tag: 'UnsupportedEvidence',
      reason: 'not-a-page',
      url: 'https://nuxtseo.com/',
    } })
  })

  it('gets URL traffic without turning it into an indexed verdict', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: {
        Clicks: 3,
        Impressions: 40,
        IsPage: true,
        Url: 'https://nuxtseo.com/',
      } })),
    })

    const result = await client.getUrlTrafficInfo('https://nuxtseo.com/', 'https://nuxtseo.com/')

    expect(result).toEqual({ ok: true, value: {
      clicks: 3,
      impressions: 40,
      isPage: true,
      url: 'https://nuxtseo.com/',
    } })
  })

  it('paginates child URL information from page zero until empty', async () => {
    const fetch = queuedFetch(
      json({ d: [{ ...urlInfoWire, Url: 'https://nuxtseo.com/a' }] }),
      json({ d: [{ ...urlInfoWire, Url: 'https://nuxtseo.com/b' }] }),
      json({ d: [] }),
    )
    const client = bingWebmaster({ accessToken: 'access-token', clock, fetch })

    const result = await client.getChildrenUrlInfo(
      'https://nuxtseo.com/',
      'https://nuxtseo.com/',
      { filters: { httpCode: '2xx' } },
    )

    expect(result.ok && result.value.map(item => item.url)).toEqual([
      'https://nuxtseo.com/a',
      'https://nuxtseo.com/b',
    ])
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).page)).toEqual([0, 1, 2])
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({
      filterProperties: { HttpCodeFilters: 1 },
    })
  })

  it('stops child pagination at the configured bound', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [urlInfoWire] })),
    })

    const result = await client.getChildrenUrlInfo(
      'https://nuxtseo.com/',
      'https://nuxtseo.com/',
      { maxPages: 1 },
    )

    expect(result).toEqual({ ok: false, error: {
      _tag: 'PaginationLimitExceeded',
      maxPages: 1,
    } })
  })

  it('rejects a child page count outside the Bing UInt16 page range', async () => {
    const fetch = vi.fn() as unknown as BingFetch
    const client = bingWebmaster({ accessToken: 'access-token', clock, fetch })

    const result = await client.getChildrenUrlInfo(
      'https://nuxtseo.com/',
      'https://nuxtseo.com/',
      { maxPages: 65_537 },
    )

    expect(result).toEqual({ ok: false, error: {
      _tag: 'InvalidPagination',
      maximum: 65_536,
      maxPages: 65_537,
      minimum: 1,
      reason: 'max-pages-out-of-range',
    } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('gets page statistics with normalized dates', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [{
        AvgClickPosition: -1,
        AvgImpressionPosition: 4.25,
        Clicks: 3,
        Date: '/Date(1786406400000)/',
        Impressions: 40,
        Query: 'https://nuxtseo.com/',
      }] })),
    })

    const result = await client.getPageStats('https://nuxtseo.com/')

    expect(result).toEqual({ ok: true, value: [{
      averageClickPosition: null,
      averageImpressionPosition: 4.25,
      clicks: 3,
      date: '2026-08-11T00:00:00.000Z',
      impressions: 40,
      page: 'https://nuxtseo.com/',
    }] })
  })

  it('gets top query statistics without treating a query as a page', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [{
        AvgClickPosition: 6.5,
        AvgImpressionPosition: 7.25,
        Clicks: 12,
        Date: '/Date(1786406400000)/',
        Impressions: 240,
        Query: 'nuxt seo',
      }] })),
    })

    const result = await client.getQueryStats('https://nuxtseo.com/')

    expect(result).toEqual({ ok: true, value: [{
      averageClickPosition: 6.5,
      averageImpressionPosition: 7.25,
      clicks: 12,
      date: '2026-08-11T00:00:00.000Z',
      impressions: 240,
      query: 'nuxt seo',
    }] })
  })

  it('gets daily crawl statistics and preserves optional failure counts', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [{
        AllOtherCodes: 3,
        BlockedByRobotsTxt: 4,
        Code2xx: 9998,
        Code301: 5,
        Code302: 6,
        Code4xx: 7,
        Code5xx: 8,
        ConnectionTimeout: 9,
        ContainsMalware: 10,
        CrawlErrors: 11,
        CrawledPages: 10042,
        Date: '/Date(1786406400000)/',
        DnsFailures: 12,
        InIndex: 1000,
        InLinks: 2048,
      }] })),
    })

    const result = await client.getCrawlStats('https://nuxtseo.com/')

    expect(result).toEqual({ ok: true, value: [{
      allOtherCodes: 3,
      blockedByRobotsTxt: 4,
      code2xx: 9998,
      code301: 5,
      code302: 6,
      code4xx: 7,
      code5xx: 8,
      connectionTimeout: 9,
      containsMalware: 10,
      crawlErrors: 11,
      crawledPages: 10042,
      date: '2026-08-11T00:00:00.000Z',
      dnsFailures: 12,
      inIndex: 1000,
      inLinks: 2048,
    }] })
  })

  it('preserves unknown crawl issue codes', async () => {
    const client = bingWebmaster({
      accessToken: 'access-token',
      clock,
      fetch: queuedFetch(json({ d: [{
        HttpCode: 418,
        InLinks: 2,
        Issues: 1024,
        Url: 'https://nuxtseo.com/teapot',
      }] })),
    })

    const result = await client.getCrawlIssues('https://nuxtseo.com/')

    expect(result).toEqual({ ok: true, value: [{
      httpCode: 418,
      inLinks: 2,
      issue: 'unknown',
      rawIssueCode: 1024,
      url: 'https://nuxtseo.com/teapot',
    }] })
  })
})
