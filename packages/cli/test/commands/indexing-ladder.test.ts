import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { COVERAGE_STATE_TAGS } from '@gscdump/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

const envelope = (data: unknown) => Response.json({ data, meta: { requestId: 'req_ladder', surface: 'partner', version: '1.0' } })
const zeroCounts = Object.fromEntries(COVERAGE_STATE_TAGS.map(tag => [tag, 0]))
const freshness = { _tag: 'measured', verdicts: 1487, olderThan7d: 1484, olderThan30d: 1231, olderThan7dPercent: 99.8, olderThan30dPercent: 82.8 }

function trendPoint(date: string, coverageStates: unknown) {
  return {
    date,
    totalUrls: 1487,
    indexedCount: 1,
    notIndexedCount: 1486,
    errorCount: 0,
    indexedPercent: 0.1,
    issues: { blockedByRobots: 0, noindexDetected: 0, soft404: 0, redirect: 0, notFound: 0, serverError: 0 },
    coverage: { submittedIndexed: 1, crawledNotIndexed: 0, discoveredNotCrawled: 2 },
    coverageStates,
    signals: { mobilePass: 0, mobileFail: 0, richResultsPass: 0, richResultsFail: 0 },
  }
}

const summary = {
  trend: [
    trendPoint('2026-09-28', { _tag: 'not_counted' }),
    trendPoint('2026-09-29', {
      _tag: 'counted',
      capturedAt: '2026-09-29T02:00:00.000Z',
      counts: { ...zeroCounts, unknown_to_google: 1484, discovered_not_indexed: 2, crawled_not_indexed: 0, indexed: 1 },
      freshness,
    }),
  ],
  summary: {
    totalUrls: 1487,
    indexed: 1,
    notIndexed: 1486,
    pending: 0,
    indexedPercent: 0.1,
    oldestCheck: null,
    newestCheck: null,
    change7d: null,
    change28d: null,
    signals: { mobilePass: 0, mobileFail: 0, mobileUnspecified: 0, richResultsPass: 0, richResultsFail: 0, richResultTypes: [], crawlingMobile: 0, crawlingDesktop: 0 },
  },
  meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced', indexingStatus: 'complete', indexingProgress: 100, sitemapTotal: 1487, inspectedCount: 1487, noSitemapsSubmitted: false, sitemapsPending: false },
  capture: {
    _tag: 'captured',
    capturedAt: '2026-09-29T02:00:00.000Z',
    source: 'stored',
    scope: 'sitemap_members',
    oldestVerdictAt: '2026-08-20T03:00:00.000Z',
    newestVerdictAt: '2026-09-29T01:00:00.000Z',
    freshness,
  },
}

const watched = {
  watched: [
    {
      url: 'https://example.com/guide',
      addedAt: '2026-09-16T00:00:00.000Z',
      dueAt: '2026-10-07T01:00:00.000Z',
      checkpoints: [
        { checkedAt: '2026-09-30T01:00:00.000Z', coverageState: 'discovered_not_indexed', googleCoverageState: 'Discovered - currently not indexed', verdict: 'NEUTRAL', lastCrawlTime: null },
        { checkedAt: '2026-09-23T01:00:00.000Z', coverageState: 'unknown_to_google', googleCoverageState: 'URL is unknown to Google', verdict: 'NEUTRAL', lastCrawlTime: null },
      ],
    },
    { url: 'https://example.com/new', addedAt: '2026-09-30T00:00:00.000Z', dueAt: '2026-09-30T00:00:00.000Z', checkpoints: [] },
  ],
  limit: 50,
  cadenceDays: 7,
  meta: { siteUrl: 'sc-domain:example.com' },
}

describe('hosted indexing summary and watch commands', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let requests: Array<{ url: URL, method: string, body: unknown }>

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-indexing-ladder-'))
    stderr = ''
    runtime = createCliRuntime({
      configDir,
      environment: { GSCDUMP_API_KEY: 'gsd_user_private', GSCDUMP_CONFIG_DIR: configDir },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk
          return true
        },
      } as unknown as NodeJS.WriteStream,
    })
    runtime.logger.level = 3
    stdout = []
    requests = []
    vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/cli/me'))
        return Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com' }] })
      if (url.pathname.endsWith('/sites/s_site/indexing'))
        return envelope(summary)
      if (url.pathname.endsWith('/sites/s_site/indexing/watched') && method === 'GET')
        return envelope(watched)
      if (url.pathname.endsWith('/sites/s_site/indexing/watched') && method === 'POST' && (requests.at(-1)!.body as { urls: string[] }).urls.includes('https://example.com/off'))
        return envelope({ changed: [], unchanged: [], skipped: [{ url: 'https://example.com/off', reason: 'inspection_disabled' }], total: 0, limit: 50 })
      if (url.pathname.endsWith('/sites/s_site/indexing/watched') && method === 'POST' && requests.at(-1)!.body && (requests.at(-1)!.body as { urls: string[] }).urls.some(u => u.includes('/bulk/'))) {
        const { urls } = requests.at(-1)!.body as { urls: string[] }
        const skipped = urls.filter(u => u.endsWith('/skip')).map(u => ({ url: u, reason: 'limit_reached' }))
        return envelope({ changed: urls.filter(u => !u.endsWith('/skip')), unchanged: [], skipped, total: requests.filter(r => r.method === 'POST').length * 10, limit: 50 })
      }
      if (url.pathname.endsWith('/sites/s_site/indexing/watched') && method === 'POST') {
        return envelope({
          changed: ['https://example.com/guide'],
          unchanged: ['https://example.com/old'],
          skipped: [{ url: 'https://other.dev/x', reason: 'domain_mismatch' }],
          total: 2,
          limit: 50,
        })
      }
      if (url.pathname.endsWith('/sites/s_site/indexing/watched/remove'))
        return envelope({ changed: ['https://example.com/guide'], unchanged: [], skipped: [], total: 1, limit: 50 })
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime })
  const apiRequests = () => requests.filter(request => !request.url.pathname.endsWith('/cli/me'))

  it('prints the hosted summary JSON unchanged', async () => {
    await run(['indexing', 'summary', '--site', 'example.com', '--days', '7', '--json'])

    const [request] = apiRequests()
    expect(request!.url.searchParams.get('days')).toBe('7')
    expect(JSON.parse(stdout.join('\n'))).toEqual(summary)
  })

  it('shows the four ladder counts per day and marks a day with no counts', async () => {
    await run(['indexing', 'summary', '--site', 'example.com'])

    const output = stdout.join('\n')
    const counted = stdout.find(line => line.includes('2026-09-29'))
    expect(counted?.split(/\s+/)).toEqual(expect.arrayContaining(['1484', '2', '0', '1']))
    expect(stdout.find(line => line.includes('2026-09-28'))).toContain('not counted')
    expect(output).toContain('Counted 2026-09-29T02:00:00.000Z from stored URL Inspection verdicts (stored).')
    expect(output).toContain('99.8% are older than 7 days and 82.8% are older than 30 days.')
    expect(output).toContain('The counts cover URLs in the Site\'s live sitemaps.')
    expect(stderr).toContain('not Google\'s live index')
  })

  it('lists each Watched URL with its latest Checkpoint', async () => {
    await run(['indexing', 'watch', 'list', '--site', 'example.com'])

    expect(stdout.find(line => line.includes('https://example.com/guide'))).toContain('discovered_not_indexed')
    expect(stdout.find(line => line.includes('https://example.com/new'))).toContain('awaiting inspection')
  })

  it('adds positional URLs and prints the skipped ones with their reason', async () => {
    await run(['indexing', 'watch', 'add', '--site', 'example.com', 'https://example.com/guide', 'https://other.dev/x'])

    const [request] = apiRequests()
    expect([request!.method, request!.body]).toEqual(['POST', { urls: ['https://example.com/guide', 'https://other.dev/x'] }])
    expect(stdout).toEqual([
      'Added: https://example.com/guide',
      'Already watched: https://example.com/old',
      'Skipped (domain_mismatch): https://other.dev/x',
    ])
    expect(stderr).toContain('sc-domain:example.com has 2 of 50 Watched URLs.')
  })

  it('removes URLs through the remove route', async () => {
    await run(['indexing', 'watch', 'remove', '--site', 'example.com', 'https://example.com/guide', '--json'])

    const [request] = apiRequests()
    expect(request!.url.pathname).toMatch(/\/indexing\/watched\/remove$/)
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ changed: ['https://example.com/guide'], total: 1 })
  })

  it('splits more than 50 URLs into requests of 50 and merges the skipped ones', async () => {
    const urls = Array.from({ length: 120 }, (_, index) => `https://example.com/bulk/${index}`)
    urls[110] = 'https://example.com/bulk/skip2/skip'
    await run(['indexing', 'watch', 'add', '--site', 'example.com', '--json', ...urls])

    const posts = apiRequests()
    expect(posts.map(request => (request.body as { urls: string[] }).urls.length)).toEqual([50, 50, 20])
    const merged = JSON.parse(stdout.join('\n'))
    expect(merged.changed).toHaveLength(119)
    expect(merged.skipped).toEqual([{ url: 'https://example.com/bulk/skip2/skip', reason: 'limit_reached' }])
    expect(merged.total).toBe(30)
  })

  it('rejects a relative URL before any request, and names it', async () => {
    expect(await run(['indexing', 'watch', 'add', '--site', 'example.com', 'https://example.com/a', '/guide'])).toBe(1)
    expect(`${stderr}${vi.mocked(console.error).mock.calls.flat().join(' ')}`).toContain('Not an absolute URL: /guide')
    expect(requests.filter(request => request.method === 'POST')).toEqual([])
  })

  it('prints why a Site with URL Inspection off skips a URL', async () => {
    await run(['indexing', 'watch', 'add', '--site', 'example.com', 'https://example.com/off'])
    expect(stdout.join('\n')).toContain('Skipped (inspection_disabled): https://example.com/off')
    expect(stdout.join('\n')).toContain('turn on URL Inspection')
  })
})
