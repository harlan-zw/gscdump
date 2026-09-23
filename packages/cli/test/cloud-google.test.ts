import type { CliRuntime } from '../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { classifyError } from 'gscdump/errors'
import { between, date, gsc, query } from 'gscdump/query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { saveAuthentication } from '../src/auth-state'
import { sitemapsCommand } from '../src/commands/sitemaps'
import { createCommandContext } from '../src/context'
import { createGscMcpServer } from '../src/mcp/server'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'

let runtime: CliRuntime
let requests: { url: string, options: RequestInit }[]
const siteUrl = 'sc-domain:example.com'

beforeEach(async () => {
  runtime = createCliRuntime({ configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-cloud-google-')), environment: {} })
  requests = []
  await runWithCliRuntime(runtime, () => saveAuthentication({ _tag: 'Cloud', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_test' }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    requests.push({ url: String(url), options })
    if (url.endsWith('/sites'))
      return Response.json([{ siteUrl, permissionLevel: 'siteOwner' }])
    const body = JSON.parse(String(options.body))
    return Response.json({
      rows: body.startRow === 0 ? [{ keys: ['example'], clicks: 3, impressions: 8, ctr: 0.375, position: 2 }] : [],
      metadata: { first_incomplete_date: '2026-09-08' },
      responseAggregationType: 'byProperty',
    })
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await fs.rm(runtime.configDir, { recursive: true, force: true })
})

it('routes saved cloud authentication through hosted Sites and paginated Google queries', async () => {
  const ctx = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true }))
  expect(await ctx.resolveSite()).toBe(siteUrl)
  const builder = gsc.select(query).where(between(date, '2026-09-01', '2026-09-08'))
  const iterator = ctx.client!.query(siteUrl, builder)
  expect((await iterator.next()).value).toEqual([{ query: 'example', clicks: 3, impressions: 8, ctr: 0.375, position: 2 }])
  expect(await iterator.next()).toEqual({ done: true, value: { metadata: { first_incomplete_date: '2026-09-08' }, responseAggregationType: 'byProperty' } })
  expect(requests.map(request => request.url)).toEqual([
    'https://gscdump.com/api/cli/gsc/sites',
    'https://gscdump.com/api/cli/gsc/query',
    'https://gscdump.com/api/cli/gsc/query',
  ])
  expect(requests.map(request => new Headers(request.options.headers).get('x-api-key'))).toEqual(['gsd_user_test', 'gsd_user_test', 'gsd_user_test'])
  expect(JSON.parse(String(requests[2].options.body))).toMatchObject({ raw: true, startRow: 1, siteUrl })
})

it('rejects cloud Google indexing and verification before sending credentials', async () => {
  const ctx = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true }))
  await expect(ctx.client!.indexing.publish('https://example.com/', 'URL_UPDATED')).rejects.toThrow(/local/)
  await expect(ctx.client!.verification.list()).rejects.toThrow(/local/)
  expect(requests).toEqual([])
})

it('preserves raw query controls, inspection evidence, and sitemap metadata through cloud transport', async () => {
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    requests.push({ url: String(url), options: options! })
    if (String(url).includes('/sitemaps?'))
      return Response.json({ sitemaps: [{ path: 'https://example.com/a.xml', type: 'sitemap', contents: [{ type: 'web', submitted: '3', indexed: '2' }] }] })
    if (String(url).endsWith('/inspect'))
      return Response.json({ inspectionResult: { inspectionResultLink: 'https://search.google.com/result', indexStatusResult: { verdict: 'PASS' } } })
    return Response.json({ rows: [] })
  })
  const { client } = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true }))
  await client!.searchAnalytics.query(siteUrl, { startDate: '2026-09-01', endDate: '2026-09-08', dimensions: [], dataState: 'all', aggregationType: 'byProperty', type: 'image', startRow: 12, rowLimit: 4 })
  expect(JSON.parse(String(requests[0].options.body))).toMatchObject({ raw: true, dimensions: [], dataState: 'all', aggregationType: 'byProperty', searchType: 'image', startRow: 12, rowLimit: 4 })
  expect(await client!.inspect(siteUrl, 'https://example.com/a', { languageCode: 'fr-FR' })).toMatchObject({ inspectionResult: { inspectionResultLink: 'https://search.google.com/result' } })
  expect(JSON.parse(String(requests[1].options.body))).toEqual({ siteUrl, urls: ['https://example.com/a'], languageCode: 'fr-FR', raw: true })
  expect(await client!.sitemaps.list(siteUrl, { sitemapIndex: 'https://example.com/index.xml' })).toEqual([{ path: 'https://example.com/a.xml', type: 'sitemap', contents: [{ type: 'web', submitted: '3', indexed: '2' }] }])
  expect(new URL(requests[2].url).searchParams.get('sitemapIndex')).toBe('https://example.com/index.xml')
})

it('routes sitemap reads and writes with escaped Site and feed URLs', async () => {
  const site = 'https://example.com/path/'
  const feed = 'https://example.com/path/sitemap.xml?part=2&lang=fr'
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    requests.push({ url: String(url), options: options! })
    return Response.json(JSON.parse(String(options!.body)).action === 'get' ? { path: feed, type: 'sitemap' } : { success: true })
  })
  const { client } = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true }))
  expect(await client!.sitemaps.get(site, feed)).toEqual({ path: feed, type: 'sitemap' })
  expect(await client!.sitemaps.submit(site, feed)).toBeUndefined()
  expect(await client!.sitemaps.delete(site, feed)).toBeUndefined()
  expect(requests.map(request => JSON.parse(String(request.options.body)))).toEqual([
    { siteUrl: site, sitemapUrl: feed, action: 'get' },
    { siteUrl: site, sitemapUrl: feed, action: 'submit' },
    { siteUrl: site, sitemapUrl: feed, action: 'delete' },
  ])
})

it('uses the cloud client for MCP queries and returns local capability errors', async () => {
  const ctx = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true }))
  const server = createGscMcpServer({ getContext: () => ({ auth: ctx.auth, authentication: ctx.authentication, client: ctx.client! }) })
  const client = new Client({ name: 'cloud-google-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: 'query', arguments: { siteUrl, startDate: '2026-09-01', endDate: '2026-09-08', dimensions: ['query'] } })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('example') }])
    const indexing = await client.callTool({ name: 'request-indexing', arguments: { url: 'https://example.com/' } })
    expect(indexing.isError).toBe(true)
    expect(indexing.content).toEqual([{ type: 'text', text: expect.stringContaining('local') }])
    expect(requests.every(request => request.url.startsWith('https://gscdump.com/api/'))).toBe(true)
  }
  finally {
    await client.close()
    await server.close()
  }
})

it.each([
  { status: 401, kind: 'auth-expired' },
  { status: 429, kind: 'rate-limited' },
])('preserves hosted HTTP $status errors for command handling', async ({ status, kind }) => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: 'Hosted request failed' } }, { status, headers: { 'retry-after': '12' } }))
  const { client } = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true, fetchOptions: { retry: 0 } }))
  const error = await client!.sites().then(() => {
    throw new Error('Expected hosted failure')
  }, classifyError)
  expect(error.kind).toBe(kind)
  if (error.kind === 'rate-limited')
    expect(error.retryAfter).toBe(12)
})

it('names the gscdump.com API key on a hosted 401, not a Google URL', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: 'Unauthorized' } }, { status: 401 }))
  const { client } = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true, fetchOptions: { retry: 0 } }))
  const error = await client!.sites().then(() => {
    throw new Error('Expected hosted failure')
  }, classifyError)
  expect(error.message).toContain('gscdump.com rejected the API key')
  expect(error.message).not.toContain('googleapis.com')
})

it('uses saved cloud authentication for hosted sitemap commands', async () => {
  const data = {
    sitemaps: [],
    history: [],
    perSitemapHistory: {},
    generation: null,
    meta: { siteUrl, gscPropertyUrl: siteUrl, syncStatus: 'synced', sitemapScope: { excludedCount: 0, duplicateCount: 0 } },
  }
  vi.mocked(fetch).mockResolvedValue(Response.json({ data, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } }))
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const command = sitemapsCommand.subCommands!.current
  await runWithCliRuntime(runtime, () => command.run!({ args: { 'site-id': 's_01', 'json': true }, rawArgs: [], cmd: command }))
  expect(JSON.parse(output.mock.calls[0][0])).toEqual(data)
  const [url, options] = vi.mocked(fetch).mock.calls[0]
  expect(String(url)).toBe('https://gscdump.com/api/partner/v1/sites/s_01/sitemaps')
  expect(new Headers(options?.headers).get('authorization')).toBe('Bearer gsd_user_test')
})
