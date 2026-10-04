import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

describe('hosted inspection refresh', () => {
  let runtime: CliRuntime
  let output: string[]
  let posts: { url: string, body: unknown }[]
  let response: () => Response
  const result = {
    url: 'https://example.com/a',
    verdict: 'PASS',
    coverageState: 'Submitted and indexed',
    indexingState: null,
    robotsTxtState: null,
    pageFetchState: null,
    lastCrawlTime: null,
    crawlingUserAgent: null,
    userCanonical: null,
    googleCanonical: null,
    sitemaps: null,
    referringUrls: null,
    mobileVerdict: null,
    mobileIssues: null,
    richResultsVerdict: null,
    richResultsItems: null,
    ampVerdict: null,
    ampUrl: null,
    ampIndexingState: null,
    ampIndexStatusVerdict: null,
    ampRobotsTxtState: null,
    ampPageFetchState: null,
    ampLastCrawlTime: null,
    ampIssues: null,
    inspectionResultLink: null,
  }
  const data = { siteId: 's_site', rateLimit: { reserved: 1, remaining: 1999, limit: 2000 }, results: [result], errors: [], skipped: [] }

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-inspect-'))
    runtime = createCliRuntime({ configDir, environment: { GSCDUMP_API_KEY: 'gsd_user_private', GSCDUMP_CONFIG_DIR: configDir } })
    output = []
    posts = []
    response = () => Response.json({ data, meta: { requestId: 'req_inspect', surface: 'partner', version: '1.0' } })
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname.endsWith('/cli/me'))
        return Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com' }] })
      posts.push({ url: url.pathname, body: JSON.parse(String(init?.body)) })
      return response()
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (...urls: string[]) => runCli({ rawArgs: ['indexing', 'inspect', ...urls, '--site', 'example.com', '--json', '--yes'], runtime })

  it('sends one deduplicated refresh through the hosted SDK and preserves the quota result', async () => {
    expect(await run('https://example.com/a', 'https://example.com/a')).toBe(0)
    expect(posts).toEqual([{ url: '/api/partner/v1/sites/s_site/indexing/inspect', body: { urls: ['https://example.com/a'] } }])
    expect(JSON.parse(output.join('\n'))).toEqual(data)
  })

  it('requires consent before any inspection request', async () => {
    expect(await runCli({ rawArgs: ['indexing', 'inspect', 'https://example.com/a', '--json'], runtime })).toBe(1)
    expect(posts).toEqual([])
    expect(JSON.parse(output.join('\n')).error.message).toContain('--yes')
  })

  it.each(['not-a-url', 'ftp://example.com/a', 'https://user:secret@example.com/a', 'https://example.com/a#part'])('rejects invalid input %s before spending quota', async (url) => {
    expect(await run(url)).toBe(1)
    expect(posts).toEqual([])
    expect(JSON.parse(output.join('\n')).error.message).toContain('Invalid URL')
  })

  it('reads a file and deduplicates its URLs', async () => {
    const file = path.join(runtime.configDir, 'urls.txt')
    await fs.writeFile(file, 'https://example.com/a\nhttps://example.com/a\n')
    expect(await run('--file', file)).toBe(0)
    expect(posts[0]?.body).toEqual({ urls: ['https://example.com/a'] })
  })

  it('prints the Google verdict in text mode', async () => {
    expect(await runCli({ rawArgs: ['indexing', 'inspect', 'https://example.com/a', '--site', 'example.com', '--yes'], runtime })).toBe(0)
    expect(output.join('\n')).toContain('https://example.com/a: Submitted and indexed')
  })

  it('rejects more than ten URLs rather than making automatic quota-spending batches', async () => {
    expect(await run(...Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`))).toBe(1)
    expect(posts).toEqual([])
    expect(JSON.parse(output.join('\n')).error.message).toContain('10')
  })

  it('does not retry a rate limit and reports the wait time', async () => {
    response = () => Response.json({ error: { code: 'rate_limited', requestId: 'req_limit', message: 'Inspection quota used up.', retryable: true, details: { retryAfterSeconds: 120 } } }, { status: 429 })
    expect(await run('https://example.com/a')).toBe(1)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(output.join('\n')).error).toMatchObject({ code: 'QUOTA_USED_UP', message: expect.stringContaining('120 seconds') })
  })

  it('preserves partial results and stops when the engine skips URLs', async () => {
    const partial = { ...data, skipped: [{ url: 'https://example.com/b', reason: 'rate_limited' }] }
    response = () => Response.json({ data: partial, meta: { requestId: 'req_partial', surface: 'partner', version: '1.0' } })
    expect(await run('https://example.com/a', 'https://example.com/b')).toBe(1)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(output.join('\n'))).toEqual(partial)
  })
})
