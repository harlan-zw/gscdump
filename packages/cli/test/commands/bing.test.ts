import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bingCommand } from '../../src/commands/bing'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

const site = 'https://example.com/'
const sites = [{ Url: site, IsVerified: true, AuthenticationCode: '', DnsVerificationCode: '' }]
const stats = { Date: '/Date(1786406400000)/', Clicks: 12, Impressions: 80 }

describe('bing commands', () => {
  let runtime: CliRuntime
  let output: string[]
  let requests: URL[]
  let replies: Record<string, unknown>

  beforeEach(async () => {
    runtime = createCliRuntime({
      configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-bing-')),
      environment: { BING_API_KEY: 'private-key' },
    })
    output = []
    requests = []
    replies = {
      GetUserSites: sites,
      GetRankAndTrafficStats: [stats],
      GetPageStats: [{ ...stats, Query: `${site}page`, AvgClickPosition: 2, AvgImpressionPosition: 3 }],
      GetQueryStats: [{ ...stats, Query: 'hello, "world"', AvgClickPosition: 2, AvgImpressionPosition: 3 }],
      GetCrawlStats: [],
      GetCrawlIssues: [],
      GetUrlInfo: null,
    }
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(input)
      requests.push(url)
      const reply = replies[url.pathname.split('/').at(-1)!]
      return reply instanceof Response ? reply : Response.json({ d: reply })
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  function run(rawArgs: string[]) {
    runtime.rawArgs = ['bing', ...rawArgs]
    return runWithCliRuntime(runtime, () => runCommand(bingCommand, { rawArgs }))
  }

  it('saves a verified key, lists sites in another invocation, and logs out without removing Google tokens', async () => {
    await fs.writeFile(path.join(runtime.configDir, 'tokens.json'), JSON.stringify({ access_token: 'google-token' }))
    await run(['login', '--json'])
    delete runtime.environment.BING_API_KEY
    await run(['sites', '--json'])
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ searchEngine: 'bing', sites: [{ url: site, isVerified: true }] })
    expect(requests.at(-1)!.searchParams.get('apikey')).toBe('private-key')
    await run(['logout', '--json'])
    await expect(run(['sites', '--json'])).rejects.toThrow('gscdump bing login')
    expect(JSON.parse(await fs.readFile(path.join(runtime.configDir, 'tokens.json'), 'utf8'))).toEqual({ access_token: 'google-token' })
    expect(output.join('\n')).not.toContain('private-key')
  })

  it('dumps every dataset, crawl issues included, using the verified URL returned by Bing', async () => {
    const out = path.join(runtime.configDir, 'export')
    await run(['dump', '--site', 'https://example.com', '--out', out, '--json'])
    const summary = JSON.parse(output.at(-1)!)
    expect(summary).toMatchObject({ searchEngine: 'bing', siteUrl: site })
    const data: Record<string, unknown> = {}
    for (const file of summary.files)
      data[file.dataset] = JSON.parse(await fs.readFile(file.path, 'utf8'))
    expect(data).toMatchObject({
      'traffic': [{ clicks: 12, impressions: 80 }],
      'pages': [{ page: `${site}page`, averageClickPosition: 2, averageImpressionPosition: 3 }],
      'keywords': [{ query: 'hello, "world"' }],
      'crawl': [],
      'crawl-issues': [],
    })
    expect(requests.filter(url => !url.pathname.endsWith('GetUserSites')).map(url => url.searchParams.get('siteUrl')))
      .toEqual([site, site, site, site, site])
  })

  it('exports CSV with escaped keywords and filters the returned dates', async () => {
    const out = path.join(runtime.configDir, 'export')
    await run(['dump', '--site', site, '--datasets', 'keywords', '--format', 'csv', '--start', '2026-08-11', '--end', '2026-08-11', '--out', out, '--json'])
    const summary = JSON.parse(output.at(-1)!)
    expect(await fs.readFile(summary.files[0].path, 'utf8')).toContain('"hello, ""world"""')
    expect(summary.files[0].rows).toBe(1)
  })

  it('does not replace an existing dump if any dataset fails', async () => {
    const out = path.join(runtime.configDir, 'export')
    await run(['dump', '--site', site, '--out', out, '--json'])
    const summary = JSON.parse(output.at(-1)!)
    const previous = await Promise.all(summary.files.map((file: { path: string }) => fs.readFile(file.path, 'utf8')))
    replies.GetQueryStats = Response.json({ ErrorCode: 4 }, { status: 429 })
    await expect(run(['dump', '--site', site, '--out', out, '--json'])).rejects.toThrow('Throttled')
    expect(await Promise.all(summary.files.map((file: { path: string }) => fs.readFile(file.path, 'utf8')))).toEqual(previous)
  })

  it.each([
    ['--datasets', 'unknown'],
    ['--format', 'xlsx'],
    ['--start', '2026-02-30'],
    ['--start', '2026-09-01', '--end', '2026-08-01'],
  ])('rejects invalid dump options before accessing Bing: %s', async (...args) => {
    await expect(run(['dump', '--site', site, ...args])).rejects.toThrow()
    expect(requests).toEqual([])
  })

  it('refuses unverified sites', async () => {
    replies.GetUserSites = [{ ...sites[0], IsVerified: false }]
    await expect(run(['dump', '--site', site])).rejects.toThrow('verified')
    expect(requests.map(url => url.pathname.split('/').at(-1))).toEqual(['GetUserSites'])
  })

  it('returns Bing uncertainty when a URL has no observations', async () => {
    await run(['inspect', `${site}missing`, '--site', site, '--json'])
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ searchEngine: 'bing', _tag: 'UnknownEvidence', reason: 'not-observed' })
  })
})
