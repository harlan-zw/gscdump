import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveAuthentication } from '../../src/auth-state'
import { doctorCommand } from '../../src/commands/doctor'
import { saveConfig } from '../../src/config'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

const mocks = vi.hoisted(() => ({
  resolveBYOK: vi.fn(),
  loadTokens: vi.fn(),
  resolveAuth: vi.fn(),
  ofetchRaw: vi.fn(),
  ofetch: vi.fn(),
  localSites: vi.fn(),
  getWatermarks: vi.fn(),
}))

vi.mock('../../src/auth', () => ({
  resolveBYOK: mocks.resolveBYOK,
  loadTokens: mocks.loadTokens,
  resolveAuth: mocks.resolveAuth,
}))
vi.mock('../../src/env-file', () => ({ parseEnvFile: () => null }))
vi.mock('../../src/local-store', () => ({
  createLocalStore: () => ({ userId: 'local', engine: { getWatermarks: mocks.getWatermarks } }),
}))
vi.mock('ofetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ofetch')>()
  return { ...actual, ofetch: Object.assign(mocks.ofetch, { raw: mocks.ofetchRaw, create: actual.ofetch.create }) }
})
vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: (auth: Parameters<typeof actual.googleSearchConsole>[0], options?: Parameters<typeof actual.googleSearchConsole>[1]) => auth === ''
      ? actual.googleSearchConsole(auth, options)
      : { sites: mocks.localSites },
  }
})

const cloud = { _tag: 'Cloud' as const, apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_private_secret' }
const hostedSite = 'https://cloud.example.com/'

describe('doctor command', () => {
  let runtime: CliRuntime
  let root: string
  let output: string[]
  let requests: { url: URL, headers: Headers }[]
  let replies: Record<string, Response | unknown>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-doctor-'))
    runtime = createCliRuntime({ configDir: path.join(root, 'config'), environment: {} })
    const dataDir = path.join(root, 'store')
    await fs.mkdir(dataDir)
    await runWithCliRuntime(runtime, () => saveConfig({ dataDir }))
    output = []
    requests = []
    replies = {
      '/api/cli/me': { user: { publicId: 'usr_123', email: 'cloud@example.com' }, sites: [] },
      '/api/cli/gsc/sites': [{ siteUrl: hostedSite, permissionLevel: 'siteOwner' }],
    }
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    mocks.resolveBYOK.mockReturnValue(null)
    mocks.loadTokens.mockResolvedValue(null)
    mocks.resolveAuth.mockResolvedValue('local-token')
    mocks.localSites.mockResolvedValue([{ siteUrl: 'https://local.example.com/', permissionLevel: 'siteOwner' }])
    mocks.getWatermarks.mockResolvedValue([])
    mocks.ofetchRaw.mockResolvedValue({ headers: { get: () => new Date().toUTCString() } })
    mocks.ofetch.mockResolvedValue({ scope: 'webmasters indexing siteverification', email: 'local@example.com' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push({ url, headers: new Headers(init?.headers) })
      if (url.origin !== 'https://gscdump.com' || !(url.pathname in replies))
        throw new Error(`Unexpected HTTP request: ${url.origin}${url.pathname}`)
      const response = replies[url.pathname]
      return response instanceof Response ? response : Response.json(response)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function run() {
    await runWithCliRuntime(runtime, () => runCommand(doctorCommand, { rawArgs: ['--json'] }))
    return JSON.parse(output.at(-1)!) as {
      ok: boolean
      checks: { name: string, status: string, detail: string }[]
    }
  }

  async function selectCloud() {
    await runWithCliRuntime(runtime, () => saveAuthentication(cloud))
  }

  it('reports missing local authentication and keeps Store diagnostics', async () => {
    const result = await run()

    expect(result).toMatchObject({ ok: false })
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'auth', status: 'fail', detail: expect.stringContaining('init') }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'store.watermarks', status: 'pass' }))
    expect(mocks.getWatermarks).toHaveBeenCalledWith({ userId: 'local' })
  })

  it('validates local BYOK scopes and Sites', async () => {
    mocks.resolveBYOK.mockReturnValue('byok-token')

    const result = await run()

    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'auth', status: 'pass', detail: expect.stringContaining('BYOK') }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'auth.scopes', status: 'pass' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'gsc.sites', status: 'pass' }))
    expect(mocks.ofetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/tokeninfo', { query: { access_token: 'byok-token' } })
    expect(requests).toEqual([])
  })

  it('checks a hosted account and Sites without using local Google credentials', async () => {
    await selectCloud()
    mocks.resolveBYOK.mockReturnValue('unrelated-local-token')
    mocks.getWatermarks.mockResolvedValue([{ siteId: hostedSite, newestDateSynced: '2020-01-01' }])

    const result = await run()

    expect(result.ok).toBe(true)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'auth', status: 'pass' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'auth.account', detail: 'cloud@example.com' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'gsc.sites', status: 'pass' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'store.watermarks', status: 'warn', detail: expect.stringContaining(hostedSite) }))
    expect(requests.map(request => request.url.pathname)).toEqual(['/api/cli/me', '/api/cli/gsc/sites'])
    expect(requests.map(request => request.headers.get('x-api-key'))).toEqual([cloud.apiKey, cloud.apiKey])
    expect(mocks.resolveBYOK).not.toHaveBeenCalled()
    expect(mocks.loadTokens).not.toHaveBeenCalled()
    expect(mocks.resolveAuth).not.toHaveBeenCalled()
    expect(mocks.ofetch).not.toHaveBeenCalled()
    expect(mocks.ofetchRaw).not.toHaveBeenCalled()
    expect(output.join('\n')).not.toContain(cloud.apiKey)
  })

  it('reports hosted rejection without trying working local credentials', async () => {
    await selectCloud()
    mocks.resolveBYOK.mockReturnValue('working-local-token')
    replies['/api/cli/me'] = Response.json({ message: cloud.apiKey }, { status: 401 })

    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'auth', status: 'fail', detail: expect.stringContaining('401') }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'gsc.sites', status: 'warn' }))
    expect(requests.map(request => request.url.pathname)).toEqual(['/api/cli/me'])
    expect(mocks.resolveAuth).not.toHaveBeenCalled()
    expect(mocks.resolveBYOK).not.toHaveBeenCalled()
    expect(output.join('\n')).not.toContain(cloud.apiKey)
  })

  it('reports hosted Sites failures without falling back to local Sites', async () => {
    await selectCloud()
    replies['/api/cli/gsc/sites'] = Response.json({ error: 'connection_missing' }, { status: 403 })

    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'auth', status: 'pass' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'gsc.sites', status: 'fail', detail: expect.stringContaining('403') }))
    expect(mocks.localSites).not.toHaveBeenCalled()
  })

  it('honours a local mode override when cloud authentication is saved', async () => {
    await selectCloud()
    runtime.authModeOverride = 'local'
    mocks.resolveBYOK.mockReturnValue('local-override-token')

    const result = await run()

    expect(result.ok).toBe(true)
    expect(mocks.ofetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/tokeninfo', { query: { access_token: 'local-override-token' } })
    expect(mocks.localSites).toHaveBeenCalledOnce()
    expect(requests).toEqual([])
  })
})
