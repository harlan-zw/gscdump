import type { CliRuntime } from '../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bingCommand } from '../src/commands/bing'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'

const siteUrl = 'https://example.com/'
const connected = { _tag: 'connected', searchEngine: 'bing', remoteSiteUrl: siteUrl, verified: true, scopes: ['webmaster.manage'], tokenExpiresAt: null, lastEvidenceAt: null }
const sync = { _tag: 'ready', observedAt: '2026-09-10T01:00:00.000Z', providerStartDate: '2026-08-01', providerEndDate: '2026-08-31' }
const envelope = (data: unknown) => Response.json({ data, meta: { requestId: 'req_bing', surface: 'partner', version: '1.0' } })

describe('hosted Bing commands', () => {
  let runtime: CliRuntime
  let output: string[]
  let requests: URL[]
  let unavailable: boolean
  let changedSnapshot: boolean

  beforeEach(async () => {
    runtime = createCliRuntime({
      configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-bing-hosted-')),
      environment: { GSCDUMP_API_KEY: 'gsd_user_private', BING_API_KEY: 'unused-local-key' },
    })
    output = []
    requests = []
    unavailable = false
    changedSnapshot = false
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      expect(url.origin).toBe('https://gscdump.com')
      requests.push(url)
      if (url.pathname.endsWith('/cli/me')) {
        expect(new Headers(init?.headers).get('x-api-key')).toBe('gsd_user_private')
        return Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com' }] })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer gsd_user_private')
      if (url.pathname.endsWith('/connection'))
        return envelope(connected)
      if (url.pathname.endsWith('/bing/data')) {
        const offset = Number(url.searchParams.get('offset'))
        const rows = Array.from({ length: offset === 0 ? 500 : 1 }, (_, i) => ({ date: '2026-08-11', clicks: i + offset, impressions: 1000 }))
        return envelope({
          searchEngine: 'bing',
          siteUrl,
          dataset: 'traffic',
          semantics: 'site-totals',
          sync: unavailable ? { _tag: 'missing' } : { ...sync, ...(changedSnapshot && offset > 0 ? { observedAt: '2026-09-10T02:00:00.000Z' } : {}) },
          rows: unavailable ? [] : rows,
          pagination: { total: unavailable ? 0 : 501, limit: 500, offset, hasMore: !unavailable && offset === 0 },
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
  function run(args: string[]) {
    runtime.rawArgs = ['bing', ...args]
    return runWithCliRuntime(runtime, () => runCommand(bingCommand, { rawArgs: args }))
  }
  function dump() {
    return run(['dump', '--site', 's_site', '--datasets', 'traffic', '--start', '2026-08-01', '--end', '2026-08-31', '--out', path.join(runtime.configDir, 'export'), '--json'])
  }

  it('uses shared hosted authentication and exports every page through the public SDK', async () => {
    await dump()
    const summary = JSON.parse(output.at(-1)!)
    const rows = JSON.parse(await fs.readFile(summary.files[0].path, 'utf8'))
    expect(rows).toHaveLength(501)
    expect(rows.at(-1).clicks).toBe(500)
    expect(requests.filter(url => url.pathname.endsWith('/bing/data')).map(url => url.searchParams.get('offset'))).toEqual(['0', '500'])
    expect(summary.files[0]).toMatchObject({ sync, semantics: 'site-totals' })
    expect(output.join('\n')).not.toContain('gsd_user_private')
  })

  it('refuses unavailable data instead of exporting an empty success', async () => {
    unavailable = true
    await expect(dump()).rejects.toThrow('missing')
    await expect(fs.access(path.join(runtime.configDir, 'export'))).rejects.toThrow()
  })

  it('refuses mixed snapshots instead of publishing a corrupt dump', async () => {
    changedSnapshot = true
    await expect(dump()).rejects.toThrow('changed')
    await expect(fs.access(path.join(runtime.configDir, 'export'))).rejects.toThrow()
  })

  it('rejects local-only datasets before a hosted request', async () => {
    await expect(run(['dump', '--site', 's_site', '--datasets', 'crawl-issues'])).rejects.toThrow('local')
    expect(requests).toEqual([])
  })
})
