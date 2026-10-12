import type { GscdumpContext, PageStats } from '../src/index'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDevframe } from 'devframe/initiate'
import { createRpcClient } from 'devframe/rpc/client'
import { createWsRpcChannel } from 'devframe/rpc/transports/ws-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createGscdumpDevframe } from '../src/index'

vi.stubGlobal('WebSocket', WebSocket)

const API = 'https://gscdump.test/api'

interface RecordedRequest {
  url: string
  headers: Record<string, string>
  body: any
}

interface SiteFixture {
  siteId: string
  siteUrl: string
  oldestDateSynced: string
  newestDateSynced: string
}

const EXAMPLE: SiteFixture = { siteId: 's_example', siteUrl: 'example.com', oldestDateSynced: '2026-01-01', newestDateSynced: '2026-09-30' }
const OTHER: SiteFixture = { siteId: 's_other', siteUrl: 'other.dev', oldestDateSynced: '2026-01-01', newestDateSynced: '2026-09-30' }

const DAILY = [
  { date: '2026-09-20', clicks: 2, impressions: 25, ctr: 0.08, position: 5 },
  { date: '2026-09-24', clicks: 1, impressions: 10, ctr: 0.1, position: 7 },
  { date: '2026-09-30', clicks: 4, impressions: 40, ctr: 0.1, position: 2 },
]

const QUERIES = [
  { query: 'zero clicks, few impressions', clicks: 0, impressions: 3, ctr: 0, position: 9 },
  { query: 'top query', clicks: 4, impressions: 30, ctr: 0.13, position: 2 },
  { query: 'zero clicks, more impressions', clicks: 0, impressions: 12, ctr: 0, position: 11 },
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' } })
}

function rowsOk(rows: unknown[]): Response {
  return json({ data: { rows }, meta: { requestId: 'req_test', surface: 'analytics', version: '1.0', sourceName: 'test', sourceKind: 'sql', queryMs: 1 } })
}

function refusal(details: Record<string, unknown>): Response {
  return json({ error: { code: 'invalid_request', message: 'The record cannot serve this read.', requestId: 'req_test', retryable: false, details } }, 409)
}

/** A fake gscdump.com at the fetch boundary. `onRows` answers each v1 rows read. */
function fakeGscdump(options: { sites?: SiteFixture[], meStatus?: number, onRows?: (body: any) => Response }) {
  const requests: RecordedRequest[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const headers = Object.fromEntries(new Headers(input instanceof Request ? input.headers : init?.headers).entries())
    const raw = input instanceof Request ? await input.text() : init?.body
    requests.push({ url, headers, body: raw ? JSON.parse(String(raw)) : undefined })
    if (url === `${API}/cli/me`)
      return options.meStatus ? json({ message: 'no' }, options.meStatus) : json({ sites: options.sites ?? [EXAMPLE] })
    if (url.startsWith(`${API}/analytics/v1/sites/`) && url.endsWith('/rows'))
      return (options.onRows ?? defaultRows)(requests.at(-1)!.body)
    return json({ message: 'not found' }, 404)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests }
}

function filterValue(body: any, dimension: string): any {
  return body.filter._filters.find((f: any) => f.dimension === dimension)
}

/** Answers like the record: daily rows inside the requested range, or the query rows. */
function defaultRows(body: any): Response {
  if (body.dimensions[0] === 'query')
    return rowsOk(QUERIES)
  const range = filterValue(body, 'date')
  return rowsOk(DAILY.filter(row => row.date >= range.expression && row.date <= range.expression2))
}

let instance: ReturnType<typeof initDevframe> | undefined
let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'gscdump-devframe-'))
  vi.stubEnv('GSCDUMP_API_KEY', '')
  vi.stubEnv('GSCDUMP_API_ROOT', API)
  vi.stubEnv('GSCDUMP_CONFIG_DIR', configDir)
})

afterEach(async () => {
  await instance?.close()
  instance = undefined
  vi.unstubAllEnvs()
  await rm(configDir, { recursive: true, force: true })
})

/** Boot the devframe's real node side and call it over a WebSocket, as the panel does. */
async function boot(options: Parameters<typeof createGscdumpDevframe>[0]) {
  const devframe = createGscdumpDevframe(options)
  instance = initDevframe(devframe, { base: '/__gscdump/', distDir: false, host: '127.0.0.1', ws: { sidecar: true }, auth: false })
  await instance.ready
  const meta = instance.connectionMeta().websocket as { port: number, path: string }
  const rpc = createRpcClient<any, any>({}, { channel: createWsRpcChannel({ url: `ws://127.0.0.1:${meta.port}/${meta.path}` }) })
  return {
    context: (preferred: string | null = null) => rpc.$call('gscdump:get-context', preferred) as Promise<GscdumpContext>,
    pageStats: (input: { page: string, period?: string, siteId?: string }) => rpc.$call('gscdump:get-page-stats', input) as Promise<PageStats>,
  }
}

describe('page stats', () => {
  it('sums each window, weights position by impressions, and fills days without data', async () => {
    const gscdump = fakeGscdump({})
    const devframe = await boot({ apiKey: 'gsd_test', fetch: gscdump.fetch })

    const stats = await devframe.pageStats({ page: '/blog/post', period: '7d' })

    expect(stats._tag).toBe('Ok')
    if (stats._tag !== 'Ok')
      return
    expect(stats.window).toEqual({ start: '2026-09-24', end: '2026-09-30' })
    expect(stats.previousWindow).toEqual({ start: '2026-09-17', end: '2026-09-23' })
    expect(stats.totals).toEqual({ clicks: 5, impressions: 50, ctr: 0.1, position: 3 })
    expect(stats.previousTotals).toEqual({ clicks: 2, impressions: 25, ctr: 0.08, position: 5 })
    expect(stats.daily.map(day => day.date)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'])
    expect(stats.daily[1]).toEqual({ date: '2026-09-25', clicks: 0, impressions: 0, ctr: 0, position: null })
    expect(stats.dashboardUrl).toBe('https://gscdump.test/app/sites/example.com/search-console/pages/%2Fblog%2Fpost?siteId=s_example')
  })

  it('ranks queries by clicks, then by impressions', async () => {
    const devframe = await boot({ apiKey: 'gsd_test', fetch: fakeGscdump({}).fetch })

    const stats = await devframe.pageStats({ page: '/blog/post' })

    expect(stats._tag === 'Ok' && stats.queries.map(row => row.query)).toEqual(['top query', 'zero clicks, more impressions', 'zero clicks, few impressions'])
  })

  it('reads a full URL as its path, without the fragment', async () => {
    const gscdump = fakeGscdump({})
    const devframe = await boot({ apiKey: 'gsd_test', fetch: gscdump.fetch })

    const stats = await devframe.pageStats({ page: 'http://localhost:5173/blog/post?ref=nav#comments' })

    expect(stats._tag === 'Ok' && stats.path).toBe('/blog/post?ref=nav')
    const pageFilters = gscdump.requests.filter(r => r.url.endsWith('/rows')).map(r => filterValue(r.body, 'page').expression)
    expect(pageFilters).toEqual(['/blog/post?ref=nav', '/blog/post?ref=nav'])
  })

  it('ends the window before the first day the record does not hold yet', async () => {
    const gscdump = fakeGscdump({
      onRows: (body) => {
        const range = filterValue(body, 'date')
        if (range.expression2 > '2026-09-28')
          return refusal({ reason: 'range_not_synced', missingStart: '2026-09-29', missingEnd: '2026-09-30' })
        return defaultRows(body)
      },
    })
    const devframe = await boot({ apiKey: 'gsd_test', fetch: gscdump.fetch })

    const stats = await devframe.pageStats({ page: '/blog/post', period: '7d' })

    expect(stats._tag === 'Ok' && stats.window).toEqual({ start: '2026-09-22', end: '2026-09-28' })
  })

  it('leaves out the days Google has not finalized, as the dashboard does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    const fresh = { ...EXAMPLE, newestDateSynced: '2026-10-05' }
    const devframe = await boot({ apiKey: 'gsd_test', fetch: fakeGscdump({ sites: [fresh] }).fetch })

    const stats = await devframe.pageStats({ page: '/blog/post', period: '7d' })
    vi.useRealTimers()

    expect(stats._tag === 'Ok' && stats.window).toEqual({ start: '2026-09-27', end: '2026-10-03' })
  })

  it('reports a record that is not ready as no data, not as zero', async () => {
    const devframe = await boot({ apiKey: 'gsd_test', fetch: fakeGscdump({ onRows: () => refusal({ reason: 'record_not_ready' }) }).fetch })

    const stats = await devframe.pageStats({ page: '/blog/post' })

    expect(stats._tag).toBe('NoData')
  })

  it('reuses a recent read of the same page', async () => {
    const gscdump = fakeGscdump({})
    const devframe = await boot({ apiKey: 'gsd_test', fetch: gscdump.fetch })

    await devframe.pageStats({ page: '/blog/post' })
    await devframe.pageStats({ page: '/blog/post' })

    expect(gscdump.requests.filter(r => r.url.endsWith('/rows'))).toHaveLength(2)
  })

  it('rejects an empty page', async () => {
    const devframe = await boot({ apiKey: 'gsd_test', fetch: fakeGscdump({}).fetch })

    expect(await devframe.pageStats({ page: '   ' })).toEqual({ _tag: 'InvalidPage', page: '   ' })
  })
})

describe('context', () => {
  it('asks for a Site when the credential holds several and none is configured', async () => {
    const devframe = await boot({ apiKey: 'gsd_test', fetch: fakeGscdump({ sites: [EXAMPLE, OTHER] }).fetch })

    const context = await devframe.context()

    expect(context._tag).toBe('SiteRequired')
  })

  it.each([
    ['a host', { site: 'example.com' }, null],
    ['a URL', { site: 'https://example.com/' }, null],
    ['the panel pick', {}, 's_example'],
  ])('resolves the Site from %s', async (_, options, preferred) => {
    const devframe = await boot({ apiKey: 'gsd_test', fetch: fakeGscdump({ sites: [OTHER, EXAMPLE] }).fetch, ...options })

    const context = await devframe.context(preferred)

    expect(context._tag === 'Ready' && context.site.siteId).toBe('s_example')
  })

  it('lets the panel pick a Site when the site option matches none', async () => {
    const devframe = await boot({ apiKey: 'gsd_test', fetch: fakeGscdump({ sites: [EXAMPLE, OTHER] }).fetch, site: 'missing.dev' })

    expect((await devframe.context())._tag).toBe('SiteRequired')
    const picked = await devframe.context('s_other')
    expect(picked._tag === 'Ready' && picked.site.siteId).toBe('s_other')
  })

  it('uses the CLI Hosted login when no API key is set', async () => {
    await writeFile(join(configDir, 'authentication.json'), JSON.stringify({ _tag: 'Hosted', apiRoot: API, sessionId: 'cli-session' }))
    const gscdump = fakeGscdump({})
    const devframe = await boot({ fetch: gscdump.fetch })

    await devframe.pageStats({ page: '/' })

    expect(gscdump.requests.find(r => r.url.endsWith('/cli/me'))?.headers['x-cli-session']).toBe('cli-session')
    expect(gscdump.requests.find(r => r.url.endsWith('/rows'))?.headers.authorization).toBe('Bearer cli-session')
  })

  it('reports a missing credential', async () => {
    const devframe = await boot({ fetch: fakeGscdump({}).fetch })

    expect(await devframe.context()).toEqual({ _tag: 'CredentialMissing' })
  })

  it('reports a rejected credential and its source', async () => {
    const devframe = await boot({ apiKey: 'gsd_revoked', fetch: fakeGscdump({ meStatus: 401 }).fetch })

    expect(await devframe.context()).toEqual({ _tag: 'CredentialRejected', source: 'option' })
  })
})
