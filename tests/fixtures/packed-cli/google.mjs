import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import process from 'node:process'

const localBingSite = 'https://local-bing.example.com/'
const cloudSite = 'sc-domain:cloud.example.com'
const cloudBingSite = 'https://cloud.example.com/'
const bingStats = { Date: '/Date(1786406400000)/', Clicks: 12, Impressions: 80 }
const envelope = data => Response.json({ data, meta: { requestId: 'req_packed', surface: 'partner', version: '1.0' } })

function googleRows(body, hosted = false) {
  const keys = body.dimensions.map(dimension => dimension === 'page'
    ? hosted ? 'https://cloud.example.com/hosted-guide' : 'https://example.com/guide'
    : body.startDate)
  return { rows: body.startRow > 0 ? [] : [{ keys, clicks: hosted ? 9 : 5, impressions: hosted ? 90 : 50, position: 3, ctr: 0.1 }] }
}

// The installed CLI uses only these fixtures. Unknown hosts and credentials fail.
globalThis.fetch = async (request, options = {}) => {
  const url = new URL(String(request))
  const headers = new Headers(options.headers)
  appendFileSync(process.env.PACKED_CLI_REQUESTS, `${JSON.stringify({ origin: url.origin, pathname: url.pathname, offset: url.searchParams.get('offset') })}\n`)
  if (url.hostname === 'searchconsole.googleapis.com') {
    assert.equal(headers.get('authorization'), 'Bearer packed-cli-fixture')
    if (url.pathname.endsWith('/sites'))
      return Response.json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    if (url.pathname.endsWith('/searchAnalytics/query'))
      return Response.json(googleRows(JSON.parse(options.body)))
    if (url.pathname.endsWith('/sitemaps'))
      return Response.json({ sitemap: [{ path: 'https://example.com/sitemap.xml', isPending: false, errors: '0', warnings: '0', contents: [{ type: 'web', submitted: '1' }] }] })
    if (url.pathname === '/v1/urlInspection/index:inspect')
      return Response.json({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } })
  }
  if (url.origin === 'https://example.com' && url.pathname === '/sitemap.xml') {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/guide</loc></url></urlset>', {
      headers: { 'content-type': 'application/xml' },
    })
  }
  if (url.hostname === 'ssl.bing.com' || url.hostname === 'www.bing.com') {
    assert.equal(url.searchParams.get('apikey'), 'packed-bing-key')
    if (url.pathname.endsWith('/GetUserSites'))
      return Response.json({ d: [{ Url: localBingSite, IsVerified: true }] })
    assert.equal(url.searchParams.get('siteUrl'), localBingSite)
    if (url.pathname.endsWith('/GetRankAndTrafficStats'))
      return Response.json({ d: [bingStats] })
    if (url.pathname.endsWith('/GetQueryStats'))
      return Response.json({ d: [{ ...bingStats, Query: 'local search', AvgClickPosition: 2, AvgImpressionPosition: 3 }] })
  }
  if (url.hostname === 'gscdump.com') {
    if (url.pathname.startsWith('/api/cli/'))
      assert.equal(headers.get('x-api-key'), 'gsd_user_packed_fixture')
    else
      assert.equal(headers.get('authorization'), 'Bearer gsd_user_packed_fixture')
    if (url.pathname === '/api/cli/me') {
      return Response.json({
        user: { publicId: 'u_packed', email: 'packed@example.com' },
        sites: [{ siteId: 's_packed', siteUrl: cloudSite }],
      })
    }
    if (url.pathname === '/api/cli/gsc/sites')
      return Response.json([{ siteUrl: cloudSite, permissionLevel: 'siteOwner' }])
    if (url.pathname === '/api/cli/gsc/query') {
      const body = JSON.parse(options.body)
      assert.equal(body.siteUrl, cloudSite)
      return Response.json(googleRows(body, true))
    }
    if (url.pathname === '/api/partner/v1/sites/s_packed/indexing/bing/connection') {
      return envelope({
        _tag: 'connected',
        searchEngine: 'bing',
        remoteSiteUrl: cloudBingSite,
        verified: true,
        scopes: ['webmaster.manage'],
        tokenExpiresAt: null,
        lastEvidenceAt: null,
      })
    }
    if (url.pathname === '/api/partner/v1/sites/s_packed/bing/data') {
      const dataset = url.searchParams.get('dataset')
      assert(['traffic', 'keywords'].includes(dataset))
      assert.equal(url.searchParams.get('startDate'), '2026-08-01')
      assert.equal(url.searchParams.get('endDate'), '2026-08-31')
      const offset = Number(url.searchParams.get('offset'))
      assert(offset === 0 || offset === 500)
      const rows = Array.from({ length: offset === 0 ? 500 : 1 }, (_, index) => ({
        date: '2026-08-11',
        clicks: offset + index + 10,
        impressions: 1000,
        ...(dataset === 'keywords' ? { keyword: `cloud search ${offset + index}`, averageClickPosition: 2, averageImpressionPosition: 3 } : {}),
      }))
      return envelope({
        searchEngine: 'bing',
        siteUrl: cloudBingSite,
        dataset,
        semantics: dataset === 'traffic' ? 'site-totals' : 'ranked-keywords',
        sync: { _tag: 'ready', observedAt: '2026-09-10T01:00:00.000Z', providerStartDate: '2026-08-01', providerEndDate: '2026-08-31' },
        rows,
        pagination: { total: 501, limit: 500, offset, hasMore: offset === 0 },
      })
    }
  }
  throw new Error(`Unexpected fixture request: ${url.origin}${url.pathname}`)
}
