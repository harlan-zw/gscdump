import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { matchHostedSite } from '../../src/hosted-site'
import { createCliRuntime } from '../../src/runtime'

const envelope = (data: unknown) => Response.json({ data, meta: { requestId: 'req_idx', surface: 'partner', version: '1.0' } })

function urlRow(url: string, sitemaps: string[] | null = ['https://example.com/sitemap.xml']) {
  return {
    url,
    issueType: 'crawled_not_indexed',
    verdict: 'NEUTRAL',
    coverageState: 'Crawled - currently not indexed',
    indexingState: 'INDEXING_ALLOWED',
    robotsTxtState: 'ALLOWED',
    pageFetchState: 'SUCCESSFUL',
    lastCrawlTime: '2026-09-01T10:00:00Z',
    crawlingUserAgent: 'MOBILE',
    userCanonical: null,
    googleCanonical: null,
    canonicalMismatchKind: 'none',
    sitemaps,
    referringUrls: null,
    mobileVerdict: null,
    mobileIssues: null,
    richResultsVerdict: null,
    richResultsItems: null,
    inspectionResultLink: null,
    firstCheckedAt: '2026-08-01T00:00:00Z',
    lastCheckedAt: '2026-09-02T00:00:00Z',
    checkCount: 3,
  }
}

describe('hosted indexing urls and sitemap commands', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let requests: URL[]
  let accountSites: { siteId: string, siteUrl: string }[]
  let totalRows: number

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-indexing-urls-'))
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
    // Consola hides info output under test runners; the pagination hint is info.
    runtime.logger.level = 3
    stdout = []
    requests = []
    totalRows = 2
    accountSites = [
      { siteId: 's_site', siteUrl: 'sc-domain:example.com' },
      { siteId: 's_other', siteUrl: 'https://other.dev/' },
    ]
    vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')))
    // citty prints an uncaught command error here before its exit.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(input)
      requests.push(url)
      if (url.pathname.endsWith('/cli/me'))
        return Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites: accountSites })
      if (url.pathname.endsWith('/sites/s_site/indexing/urls')) {
        const offset = Number(url.searchParams.get('offset'))
        const limit = Number(url.searchParams.get('limit'))
        const count = Math.max(0, Math.min(limit, totalRows - offset))
        return envelope({
          urls: Array.from({ length: count }, (_, i) => urlRow(`https://example.com/p${offset + i}`, i === 0 ? ['https://example.com/a.xml', 'https://example.com/b.xml'] : null)),
          pagination: { total: totalRows, limit, offset, hasMore: offset + count < totalRows },
          meta: { siteUrl: 'sc-domain:example.com', status: url.searchParams.get('status') ?? 'all', issue: null },
        })
      }
      if (/\/sites\/s_[a-z0-9]+\/sitemaps$/.test(url.pathname)) {
        const siteUrl = accountSites.find(site => url.pathname.endsWith(`/sites/${site.siteId}/sitemaps`))?.siteUrl
        return envelope({
          sitemaps: [],
          history: [],
          perSitemapHistory: {},
          generation: null,
          meta: { siteUrl, gscPropertyUrl: siteUrl, syncStatus: 'synced', sitemapScope: { excludedCount: 0, duplicateCount: 0 } },
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime, loadEnv: false })
  const indexingRequests = () => requests.filter(url => url.pathname.endsWith('/indexing/urls'))

  it('resolves a bare Site through /cli/me and prints a table of not indexed URLs', async () => {
    await run(['indexing', 'urls', '--site', 'example.com', '--status', 'not_indexed'])

    expect(requests[0]!.pathname).toMatch(/\/cli\/me$/)
    const [request] = indexingRequests()
    expect(request!.pathname).toMatch(/\/sites\/s_site\/indexing\/urls$/)
    expect(Object.fromEntries(request!.searchParams)).toEqual({ status: 'not_indexed', limit: '100', offset: '0' })
    const table = stdout.join('\n')
    expect(table).toContain('https://example.com/p0')
    expect(table).toContain('Crawled - currently not indexed')
    expect(stderr).toContain('Showing 1-2 of 2 URLs for sc-domain:example.com.')
  })

  it('prints the hosted page as JSON', async () => {
    await run(['indexing', 'urls', '--site', 'sc-domain:example.com', '--json'])

    const page = JSON.parse(stdout.join('\n'))
    expect(page.urls.map((row: { url: string }) => row.url)).toEqual(['https://example.com/p0', 'https://example.com/p1'])
    expect(page.pagination).toMatchObject({ total: 2, hasMore: false })
  })

  it('prints CSV with the sitemaps of each URL', async () => {
    await run(['indexing', 'urls', '--site', 'https://example.com/', '--format', 'csv'])

    const [header, first, second] = stdout.join('\n').split('\n')
    expect(header).toBe('url,verdict,coverageState,issueType,lastCrawlTime,lastCheckedAt,googleCanonical,userCanonical,sitemaps')
    expect(first).toMatch(/^https:\/\/example\.com\/p0,.*,https:\/\/example\.com\/a\.xml https:\/\/example\.com\/b\.xml$/)
    expect(second).toMatch(/^https:\/\/example\.com\/p1,.*,$/)
  })

  it('reads every page with --all', async () => {
    totalRows = 501
    await run(['indexing', 'urls', '--site', 'example.com', '--all', '--json'])

    expect(indexingRequests().map(url => url.searchParams.get('offset'))).toEqual(['0', '500'])
    const page = JSON.parse(stdout.join('\n'))
    expect(page.urls).toHaveLength(501)
    expect(page.pagination).toEqual({ total: 501, limit: 501, offset: 0, hasMore: false })
  })

  it('tells a local-only user about the hosted requirement and the local alternative', async () => {
    runtime.environment = { GSCDUMP_CONFIG_DIR: runtime.configDir }

    expect(await run(['indexing', 'urls', '--site', 'example.com'])).toBe(1)

    expect(requests).toEqual([])
    const lines = stderr.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('`gscdump indexing urls` needs hosted authentication')
    expect(lines[0]).toContain('`gscdump inspect --site <site>`')
  })

  it('names the hosted Sites when --site matches none', async () => {
    expect(await run(['indexing', 'urls', '--site', 'missing.dev'])).toBe(1)

    expect(stderr).toContain('No hosted Site matches "missing.dev". Hosted Sites: sc-domain:example.com, https://other.dev/.')
    expect(indexingRequests()).toEqual([])
  })

  it('rejects an invalid --status before any request', async () => {
    expect(await run(['indexing', 'urls', '--site', 'example.com', '--status', 'unknown'])).toBe(1)
    expect(requests).toEqual([])
  })

  it('resolves --site for hosted sitemap reads', async () => {
    await run(['sitemaps', 'current', '--site', 'example.com', '--json'])

    expect(requests.map(url => url.pathname)).toEqual([expect.stringMatching(/\/cli\/me$/), expect.stringMatching(/\/sites\/s_site\/sitemaps$/)])
    expect(JSON.parse(stdout.join('\n')).meta.siteUrl).toBe('sc-domain:example.com')
  })

  it('rejects a leftover positional Site ID instead of silently reading the default Site', async () => {
    accountSites = [
      { siteId: 's_01', siteUrl: 'https://one.test/' },
      { siteId: 's_02', siteUrl: 'https://two.test/' },
    ]
    await fs.writeFile(path.join(runtime.configDir, 'config.json'), JSON.stringify({ defaultSite: 'two.test' }))

    await expect(run(['sitemaps', 'current', 's_01'])).rejects.toThrow('process.exit(1)')

    expect(stderr).toContain('`gscdump sitemaps current` no longer accepts a positional Site ID. Pass --site instead.')
    expect(requests).toEqual([])
    expect(stdout.join('\n')).not.toContain('two.test')
  })
})

describe('matchHostedSite', () => {
  const sites = [
    { siteId: 's_domain', siteUrl: 'sc-domain:example.com' },
    { siteId: 's_blog', siteUrl: 'https://example.com/blog/' },
  ]

  it('matches bare, domain-property, and URL-prefix spellings of one Site', () => {
    expect(matchHostedSite(sites, 'example.com')).toEqual({ kind: 'found', site: sites[0] })
    expect(matchHostedSite(sites, 'https://EXAMPLE.com')).toEqual({ kind: 'found', site: sites[0] })
    expect(matchHostedSite(sites, 'example.com/blog')).toEqual({ kind: 'found', site: sites[1] })
    expect(matchHostedSite(sites, 's_blog')).toEqual({ kind: 'found', site: sites[1] })
  })

  it('reports an ambiguous match instead of picking one', () => {
    const both = [...sites, { siteId: 's_prefix', siteUrl: 'https://example.com/' }]
    expect(matchHostedSite(both, 'example.com')).toMatchObject({ kind: 'ambiguous', matches: [both[0], both[2]] })
  })

  it('uses the only Site when --site is absent, and asks for --site otherwise', () => {
    expect(matchHostedSite([sites[0]!], undefined)).toEqual({ kind: 'found', site: sites[0] })
    expect(matchHostedSite(sites, undefined)).toEqual({ kind: 'missing', target: undefined, sites })
  })
})
