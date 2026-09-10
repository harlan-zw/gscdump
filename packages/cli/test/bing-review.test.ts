import type { CliRuntime } from '../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { saveAuthentication } from '../src/auth-state'
import { saveBingCredentials } from '../src/bing-auth'
import { resolveHostedBingSites } from '../src/bing-hosted'
import { bingCommand } from '../src/commands/bing'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'

let runtime: CliRuntime

beforeEach(async () => {
  runtime = createCliRuntime({
    configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-bing-review-')),
    environment: {},
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await fs.rm(runtime.configDir, { recursive: true, force: true })
})

it('refreshes OAuth credentials before continuing a long dump across Sites', async () => {
  let now = Date.now()
  const expiresAt = now + 61_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const output: string[] = []
  const requests: { siteUrl: string | null, authorization: string | null }[] = []
  const grants: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
  await runWithCliRuntime(runtime, () => saveBingCredentials({
    _tag: 'OAuth',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'http://127.0.0.1:53683/oauth/bing',
    accessToken: 'expires-during-dump',
    refreshToken: 'refresh-token',
    expiresAt,
  }))
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/oauth/token')) {
      grants.push(new URLSearchParams(String(init?.body)).get('grant_type')!)
      return Response.json({ access_token: 'refreshed-token', expires_in: 3600 })
    }
    if (url.pathname.endsWith('/GetUserSites')) {
      now += 21_000
      return Response.json({ d: [
        { Url: 'https://first.example.com/', IsVerified: true },
        { Url: 'https://second.example.com/', IsVerified: true },
        { Url: 'https://third.example.com/', IsVerified: true },
      ] })
    }
    if (!url.pathname.endsWith('/GetRankAndTrafficStats'))
      throw new Error(`Unexpected request: ${url.pathname}`)
    const siteUrl = url.searchParams.get('siteUrl')
    const authorization = new Headers(init?.headers).get('authorization')
    requests.push({ siteUrl, authorization })
    if (now >= expiresAt && authorization !== 'Bearer refreshed-token')
      return Response.json({ ErrorCode: 2 }, { status: 401 })
    now += 20_000
    return Response.json({ d: [{ Date: '/Date(1786406400000)/', Clicks: 12, Impressions: 80 }] })
  }))

  await runWithCliRuntime(runtime, () => runCommand(bingCommand, {
    rawArgs: ['dump', '--all-sites', '--datasets', 'traffic', '--out', path.join(runtime.configDir, 'export'), '--json'],
  }))

  expect(JSON.parse(output.at(-1)!)).toMatchObject({ sites: [
    { siteUrl: 'https://first.example.com/', files: [{ dataset: 'traffic', rows: 1 }] },
    { siteUrl: 'https://second.example.com/', files: [{ dataset: 'traffic', rows: 1 }] },
    { siteUrl: 'https://third.example.com/', files: [{ dataset: 'traffic', rows: 1 }] },
  ] })
  expect(grants).toEqual(['refresh_token'])
  expect(requests).toContainEqual({ siteUrl: 'https://third.example.com/', authorization: 'Bearer refreshed-token' })
})

it('resolves an explicit hosted Site when an unrelated shared Site denies Bing access', async () => {
  const state = { _tag: 'Cloud' as const, apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_test' }
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    requested.push(url.pathname)
    if (url.pathname === '/api/cli/me') {
      return Response.json({
        user: { publicId: 'u_allowed', email: 'allowed@example.com' },
        sites: [
          { siteId: 's_allowed', siteUrl: 'https://allowed.example.com/' },
          { siteId: 's_shared', siteUrl: 'https://shared.example.com/' },
        ],
      })
    }
    if (url.pathname.includes('/s_shared/')) {
      return Response.json({ error: {
        code: 'forbidden',
        message: 'Bing preview access is not enabled for this Site owner.',
        requestId: 'req_denied',
        retryable: false,
        details: {},
      } }, { status: 403 })
    }
    if (url.pathname.includes('/s_allowed/')) {
      return Response.json({
        data: {
          _tag: 'connected',
          searchEngine: 'bing',
          remoteSiteUrl: 'https://allowed.example.com/',
          verified: true,
          scopes: ['webmaster.manage'],
          tokenExpiresAt: null,
          lastEvidenceAt: null,
        },
        meta: { requestId: 'req_allowed', surface: 'partner', version: '1.0' },
      })
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))

  const sites = await resolveHostedBingSites(state, { site: 's_allowed' })

  expect(sites).toMatchObject([{ siteId: 's_allowed', connection: { _tag: 'connected' } }])
  expect(requested).not.toContain('/api/partner/v1/sites/s_shared/indexing/bing/connection')
})

it('lists reachable hosted Sites when one Site denies Bing access', async () => {
  const state = { _tag: 'Cloud' as const, apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_listing' }
  await runWithCliRuntime(runtime, () => saveAuthentication(state))
  const output: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))
  const warn = vi.spyOn(runtime.logger, 'warn')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname === '/api/cli/me') {
      return Response.json({
        user: { publicId: 'u_mixed', email: 'mixed@example.com' },
        sites: [
          { siteId: 's_denied', siteUrl: 'https://denied.example.com/' },
          { siteId: 's_ready', siteUrl: 'https://ready.example.com/' },
        ],
      })
    }
    if (url.pathname.includes('/s_denied/')) {
      return Response.json({ error: {
        code: 'forbidden',
        message: 'Bing preview access is not enabled for this Site owner.',
        requestId: 'req_denied',
        retryable: false,
        details: {},
      } }, { status: 403 })
    }
    if (url.pathname.includes('/s_ready/')) {
      return Response.json({
        data: {
          _tag: 'connected',
          searchEngine: 'bing',
          remoteSiteUrl: 'https://ready.example.com/',
          verified: true,
          scopes: ['webmaster.manage'],
          tokenExpiresAt: null,
          lastEvidenceAt: null,
        },
        meta: { requestId: 'req_ready', surface: 'partner', version: '1.0' },
      })
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))

  await runWithCliRuntime(runtime, () => runCommand(bingCommand, { rawArgs: ['sites', '--json'] }))

  expect(JSON.parse(output.at(-1)!)).toMatchObject({ searchEngine: 'bing', sites: [
    { siteId: 's_ready', siteUrl: 'https://ready.example.com/', connection: { _tag: 'connected' } },
  ] })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('denied.example.com'))
})

it('keeps the hard failure for an explicit hosted Site whose connection is denied', async () => {
  const state = { _tag: 'Cloud' as const, apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_explicit' }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname === '/api/cli/me') {
      return Response.json({
        user: { publicId: 'u_explicit', email: 'explicit@example.com' },
        sites: [{ siteId: 's_denied', siteUrl: 'https://denied.example.com/' }],
      })
    }
    if (url.pathname.includes('/s_denied/')) {
      return Response.json({ error: {
        code: 'forbidden',
        message: 'Bing preview access is not enabled for this Site owner.',
        requestId: 'req_denied',
        retryable: false,
        details: {},
      } }, { status: 403 })
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))

  await expect(resolveHostedBingSites(state, { site: 's_denied', requireConnected: false }))
    .rejects
    .toThrow('Bing preview access is not enabled')
})
