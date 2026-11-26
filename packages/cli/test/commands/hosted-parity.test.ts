import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { LONG_QUERY_REGEX, QUESTION_REGEX } from '../../src/filters'
import { createCliRuntime } from '../../src/runtime'

const meta = { requestId: 'req_parity', surface: 'partner', version: '1.0' } as const

describe('hosted CLI parity commands', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let requests: { method: string, url: URL, body: unknown }[]

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-parity-'))
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir: path.join(configDir, 'data') }))
    runtime = createCliRuntime({
      configDir,
      environment: { GSCDUMP_API_KEY: 'gsd_user_private', GSCDUMP_CONFIG_DIR: configDir, NO_COLOR: '1' },
      stderr: {
        write: () => true,
      } as unknown as NodeJS.WriteStream,
    })
    runtime.colorEnabled = false
    stdout = []
    requests = []
    vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const method = (request?.method ?? init?.method ?? 'GET').toUpperCase()
      const url = new URL(request ? request.url : input as string | URL)
      const text = request ? await request.text() : typeof init?.body === 'string' ? init.body : ''
      const body = text ? JSON.parse(text) : undefined
      requests.push({ method, url, body })

      if (url.pathname === '/api/cli/me') {
        return Response.json({
          user: { publicId: 'u_me', email: 'user@example.com' },
          sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com', syncStatus: 'synced' }],
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/chart-annotations' && method === 'GET') {
        return Response.json({
          data: {
            annotations: [
              { id: 'ann_01', date: '2026-10-12', label: 'Deploy v2', description: 'New nav', category: 'custom', tone: 'neutral', editable: true },
              { id: 'algo:core-2026-10', date: '2026-10-15', label: 'Core Update', category: 'algo-update', tone: 'warning', editable: false },
            ],
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/annotations' && method === 'POST') {
        return Response.json({
          data: {
            annotation: {
              id: 'ann_02',
              siteId: 's_site',
              date: body.date,
              title: body.title,
              note: body.note ?? null,
              url: body.url ?? null,
              createdAt: 1791763200,
              updatedAt: 1791763200,
            },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/annotations/ann_02' && method === 'PATCH') {
        return Response.json({
          data: {
            annotation: {
              id: 'ann_02',
              siteId: 's_site',
              date: body.date ?? '2026-10-12',
              title: body.title ?? 'Deploy v2',
              note: body.note ?? null,
              url: body.url ?? null,
              createdAt: 1791763200,
              updatedAt: 1791766800,
            },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/annotations/ann_02' && method === 'DELETE') {
        return Response.json({ data: { deleted: true, id: 'ann_02' }, meta })
      }
      if (url.pathname === '/api/analytics/v1/sites/s_site/rows' && method === 'POST') {
        return Response.json({
          data: { rows: [{ query: 'how to configure nuxt seo canonical tags properly today', clicks: 5, impressions: 50, ctr: 0.1, position: 2.1 }] },
          meta: { requestId: 'req_rows', surface: 'analytics', version: '1.0', sourceName: 'iceberg', sourceKind: 'sql', queryMs: 4 },
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/device-gap') {
        return Response.json({
          data: {
            daily: [{ date: '2026-10-01', desktop: { clicks: 10, impressions: 100, ctr: 0.1, position: 3 }, mobile: { clicks: 8, impressions: 100, ctr: 0.08, position: 4 }, gaps: { ctrGap: 0.02, positionGap: 1 } }],
            summary: { avgCtrGap: 0.02, avgPositionGap: 1, ctrGapTrend: 'stable', positionGapTrend: 'stable' },
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/position-distribution') {
        return Response.json({
          data: {
            distribution: [{ date: '2026-10-01', pos_1_3: 5, pos_4_10: 12, pos_11_20: 8, pos_20_plus: 20, total: 45 }],
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/ctr-curve') {
        return Response.json({
          data: {
            curve: [{ bucket: '1', avgCtr: 0.28, medianPosition: 1.1, keywordCount: 14, totalClicks: 140, totalImpressions: 500 }],
            overperforming: [],
            underperforming: [],
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/dark-traffic') {
        return Response.json({
          data: {
            summary: { totalClicks: 100, attributedClicks: 70, darkClicks: 30, darkPercent: 0.3, totalImpressions: 1000, attributedImpressions: 800 },
            pages: [{ url: '/pricing', totalClicks: 50, attributedClicks: 30, darkClicks: 20, darkPercent: 0.4, keywordCount: 12 }],
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/content-velocity') {
        return Response.json({
          data: {
            weekly: [{ week: '2026-W40', newKeywords: 18, totalKeywords: 200 }],
            summary: { totalNewKeywords: 18, avgPerWeek: 18, trend: 'accelerating' },
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/keyword-breadth') {
        return Response.json({
          data: {
            distribution: [{ bucket: '2-5', pageCount: 15 }],
            fragilePages: [],
            authorityPages: [],
            summary: { totalPages: 15, avgKeywordsPerPage: 3.5, fragileCount: 4, authorityCount: 1 },
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/analytics/coverage') {
        return Response.json({
          data: {
            searchType: 'web',
            current: { startDate: '2026-10-01', endDate: '2026-10-28', complete: true },
            comparison: { startDate: '2026-09-03', endDate: '2026-09-30', complete: false },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/index-percent') {
        return Response.json({
          data: {
            trend: [],
            invisibleUrls: [{ url: 'https://example.com/hidden', lastmod: null }],
            invisibleCount: 10,
            orphanPages: [{ url: 'https://example.com/orphan', impressions: 25, clicks: 2 }],
            orphanCount: 3,
            sitemaps: [{ path: 'https://example.com/sitemap.xml', urlCount: 100, isIndex: false }],
            summary: { currentPercent: 90, totalSitemapUrls: 100, visibleUrls: 90, change7d: 2.5, change28d: -1.2, dataDate: '2026-10-28' },
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced', newestDateSynced: '2026-10-28' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/canonical-mismatches') {
        return Response.json({
          data: {
            mismatches: [{ url: 'https://example.com/a', userCanonical: 'https://example.com/a', googleCanonical: 'https://example.com/b', verdict: 'NEUTRAL', coverageState: 'Duplicate', lastCrawlTime: null, lastCheckedAt: null, kind: 'path' }],
            totalCount: 1,
            consolidationTargets: [{ google_canonical: 'https://example.com/b', count: 1 }],
            trend: [],
            meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/indexing/diagnostics') {
        return Response.json({
          data: {
            summary: { totalUrls: 100, indexed: 82, indexedPercent: 82 },
            issues: [{ type: 'crawled_not_indexed', label: 'Crawled - currently not indexed', severity: 'warning', count: 18, description: 'Crawled but not indexed.', fix: 'Review content.' }],
            meta: { siteUrl: 'sc-domain:example.com' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/indexing/transitions') {
        return Response.json({
          data: {
            transitions: [{ url: 'https://example.com/a', field: 'coverageState', fromValue: 'Crawled - currently not indexed', toValue: 'Submitted and indexed', changedAfter: '2026-10-01T00:00:00Z', changedBefore: '2026-10-08T00:00:00Z', detectedAt: '2026-10-08T00:00:00Z', observationGapDays: 7 }],
            observationWindow: { _tag: 'sampled', gapDaysMedian: 7, gapDaysP90: 10, sampleSize: 1 },
            pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
            meta: { siteUrl: 'sc-domain:example.com', startDate: '2026-10-01', endDate: '2026-10-28' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/indexing/indexnow/connection' && method === 'GET') {
        return Response.json({
          data: {
            _tag: 'connected',
            host: 'example.com',
            keyLocation: 'https://example.com/key.txt',
            verifiedAt: '2026-10-01T00:00:00.000Z',
            automaticSending: { _tag: 'off' },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/indexing/indexnow/submissions' && method === 'POST') {
        return Response.json({
          data: {
            submissionReceipt: {
              _tag: 'accepted',
              id: 'sub_01',
              trigger: 'manual',
              urls: body.urls,
              createdAt: '2026-10-28T00:00:00.000Z',
              updatedAt: '2026-10-28T00:00:00.000Z',
              attempts: 1,
              httpStatus: 200,
              reason: null,
              retryAt: null,
            },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/indexing/bing/connection' && method === 'GET') {
        return Response.json({
          data: {
            _tag: 'connected',
            searchEngine: 'bing',
            remoteSiteUrl: 'https://example.com/',
            verified: true,
            scopes: ['webmaster.manage'],
            tokenExpiresAt: null,
            lastEvidenceAt: null,
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/bing/data' && method === 'GET') {
        return Response.json({
          data: {
            searchEngine: 'bing',
            siteUrl: 'https://example.com/',
            dataset: 'traffic',
            semantics: 'site-totals',
            sync: { _tag: 'ready', observedAt: '2026-10-28T00:00:00.000Z', providerStartDate: '2026-10-01', providerEndDate: '2026-10-28' },
            rows: [{ date: '2026-10-28', clicks: 25, impressions: 400 }],
            pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/bing/data/totals' && method === 'GET') {
        return Response.json({
          data: {
            searchEngine: 'bing',
            siteUrl: 'https://example.com/',
            dataset: 'keywords',
            semantics: 'ranked-keyword-totals',
            sync: { _tag: 'ready', observedAt: '2026-10-28T00:00:00.000Z', providerStartDate: '2026-10-01', providerEndDate: '2026-10-28' },
            totals: { clicks: 25, impressions: 400 },
            rows: [{ keyword: 'nuxt seo', clicks: 25, impressions: 400, averageClickPosition: 1.5, averageImpressionPosition: 2.3 }],
            pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
          },
          meta,
        })
      }
      if (url.pathname === '/api/partner/v1/sites/s_site/indexing/bing/sitemaps' && method === 'POST') {
        return Response.json({
          data: {
            _tag: 'submitted',
            sitemapUrl: body.url ?? 'https://example.com/sitemap.xml',
            sitemap: { _tag: 'awaiting-bing', checkedAt: null, lastSubmittedAt: '2026-10-28T00:00:00.000Z' },
          },
          meta,
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}${url.search}`)
    }))
  })

  afterEach(async () => {
    process.exitCode = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime })

  it('lists, creates, updates, and deletes chart annotations', async () => {
    expect(await run(['annotations', 'list', 'example.com', '--start', '2026-10-01', '--end', '2026-10-31', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).annotations).toHaveLength(2)
    const listReq = requests.find(r => r.url.pathname.endsWith('/chart-annotations'))
    expect(Object.fromEntries(listReq!.url.searchParams)).toEqual({ startDate: '2026-10-01', endDate: '2026-10-31' })

    stdout = []
    expect(await run(['annotations', 'create', 'example.com', '--date', '2026-10-20', '--title', 'Launch', '--note', 'Shipped', '--url', 'https://example.com/launch', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).annotation).toMatchObject({ id: 'ann_02', title: 'Launch' })

    stdout = []
    expect(await run(['annotations', 'update', 'example.com', 'ann_02', '--title', 'Launch v2', '--note', '', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).annotation).toMatchObject({ id: 'ann_02', title: 'Launch v2', note: null })
    const patchReq = requests.find(r => r.method === 'PATCH')
    expect(patchReq?.body).toEqual({ title: 'Launch v2', note: null })

    stdout = []
    expect(await run(['annotations', 'delete', 'example.com', 'ann_02', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n'))).toEqual({ deleted: true, id: 'ann_02' })
  })

  it('sends --questions and --long-queries regex filters on hosted query', async () => {
    expect(await run(['query', '--site', 'example.com', '-d', 'query', '--start', '2026-10-01', '--end', '2026-10-28', '--questions', 'questions', '--long-queries', '--format', 'json'])).toBe(0)
    const rowsReq = requests.find(r => r.url.pathname.endsWith('/rows'))
    expect(JSON.stringify(rowsReq?.body)).toContain(QUESTION_REGEX.replace(/\\/g, '\\\\'))
    expect(JSON.stringify(rowsReq?.body)).toContain(LONG_QUERY_REGEX.replace(/\\/g, '\\\\'))
  })

  it.each([
    ['device-gap', '/device-gap'],
    ['position-distribution', '/position-distribution'],
    ['ctr-curve', '/ctr-curve'],
    ['dark-traffic', '/dark-traffic'],
    ['content-velocity', '/content-velocity'],
    ['keyword-breadth', '/keyword-breadth'],
  ])('runs analyze %s in Hosted mode against %s', async (tool, expectedSuffix) => {
    expect(await run(['analyze', tool, '--site', 'example.com', '--start', '2026-10-01', '--end', '2026-10-28', '--json'])).toBe(0)
    const payload = JSON.parse(stdout.join('\n'))
    expect(payload.meta.source).toBe('hosted')
    expect(payload.results).toHaveLength(1)
    expect(requests.some(r => r.url.pathname.endsWith(expectedSuffix))).toBe(true)
  })

  it('checks recorded analytics coverage with sites coverage', async () => {
    expect(await run(['sites', 'coverage', 'example.com', '--start', '2026-10-01', '--end', '2026-10-28', '--vs', 'prev-period', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      siteId: 's_site',
      searchType: 'web',
      current: { startDate: '2026-10-01', endDate: '2026-10-28', complete: true },
      comparison: { complete: false },
    })
  })

  it('supports sitemaps visibility and indexing parity subcommands', async () => {
    expect(await run(['sitemaps', 'visibility', 'example.com', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).summary).toMatchObject({ currentPercent: 90, visibleUrls: 90, totalSitemapUrls: 100 })

    stdout = []
    expect(await run(['indexing', 'canonical-mismatches', 'example.com', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).totalCount).toBe(1)

    stdout = []
    expect(await run(['indexing', 'diagnostics', 'example.com', '--sample-limit', '5', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).summary.indexedPercent).toBe(82)

    stdout = []
    expect(await run(['indexing', 'transitions', 'example.com', '--start', '2026-10-01', '--end', '2026-10-28', '--field', 'coverageState', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).transitions).toHaveLength(1)

    stdout = []
    expect(await run(['indexing', 'indexnow', 'status', 'example.com', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).connection._tag).toBe('connected')

    stdout = []
    expect(await run(['indexing', 'indexnow', 'submit', 'example.com', 'https://example.com/new', '--idempotency-key', 'key_01', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n')).submissionReceipt).toMatchObject({ _tag: 'accepted', id: 'sub_01' })
  })

  it('supports hosted bing query, totals, and sitemaps submit', async () => {
    expect(await run(['bing', 'query', 's_site', '--dataset', 'traffic', '--start', '2026-10-01', '--end', '2026-10-28', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ dataset: 'traffic', rows: [{ clicks: 25 }] })

    stdout = []
    expect(await run(['bing', 'totals', 's_site', '--dataset', 'keywords', '--start', '2026-10-01', '--end', '2026-10-28', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ dataset: 'keywords', totals: { clicks: 25, impressions: 400 } })

    stdout = []
    expect(await run(['bing', 'sitemaps', 'submit', 's_site', '--sitemap', 'https://example.com/sitemap.xml', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ _tag: 'submitted', sitemapUrl: 'https://example.com/sitemap.xml' })
  })
})
