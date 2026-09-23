import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandContext } from '../src/context'

const sites = vi.hoisted(() => vi.fn())
const store = vi.hoisted(() => ({ dataDir: '' }))
vi.mock('gscdump/client', () => ({ googleSearchConsole: () => ({ sites }) }))
vi.mock('../src/auth', () => ({ resolveAuth: async () => 'token' }))
vi.mock('../src/auth-state', () => ({ resolveAuthentication: async () => ({ _tag: 'Local' }) }))
vi.mock('../src/config', () => ({ loadResolvedConfig: async () => ({ config: {}, dataDir: store.dataDir }) }))

beforeEach(async () => {
  sites.mockReset()
  store.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-context-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(store.dataDir, { recursive: true, force: true })
})

async function storeHas(siteId: string): Promise<void> {
  await fs.mkdir(path.join(store.dataDir, 'u_local', siteId), { recursive: true })
}

describe('command Site selection', () => {
  it('rejects an unknown Site instead of selecting the only account Site', async () => {
    sites.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('missing.com')).rejects.toThrow('No Site matches "missing.com". Sites: sc-domain:example.com.')
  })

  it('matches whole Sites, never a longer Site that contains the input', async () => {
    sites.mockResolvedValue([
      { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://blog.example.com/', permissionLevel: 'siteOwner' },
    ])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('example.com')).resolves.toBe('https://example.com/')
    await expect(ctx.resolveSite('Blog.Example.com')).resolves.toBe('https://blog.example.com/')
  })

  it('names the parent Site for a subdomain inside a domain property', async () => {
    sites.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('blog.example.com')).rejects.toThrow('--site example.com --page ~blog.example.com')
  })

  it('resolves a Store Site without asking Google', async () => {
    await storeHas('h_example.com')
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('example.com')).resolves.toBe('https://example.com/')
    expect(sites).not.toHaveBeenCalled()
  })

  it('prefers the Site with Store data over the account domain property', async () => {
    await storeHas('h_example.com')
    await storeHas('d_other.com')
    sites.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('www.example.com')).resolves.toBe('https://example.com/')
  })

  it('lets a full Site URL pick the exact account property over a Store Site with the same root', async () => {
    await storeHas('d_example.com')
    sites.mockResolvedValue([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
    ])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('https://example.com/')).resolves.toBe('https://example.com/')
    await expect(ctx.resolveSite('example.com')).resolves.toBe('sc-domain:example.com')
  })

  it('asks Google on a Store miss', async () => {
    await storeHas('d_other.com')
    sites.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('https://example.com')).resolves.toBe('sc-domain:example.com')
  })

  it('never asks Google for a Store-only command', async () => {
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('example.com', { scope: 'store' })).rejects.toThrow('The Store has no data. Run `gscdump sync --site example.com` first.')
    expect(sites).not.toHaveBeenCalled()
  })

  it('retains the single Site default when no Site was requested', async () => {
    sites.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite()).resolves.toBe('sc-domain:example.com')
  })

  it('propagates Site lookup failures to the caller', async () => {
    const failure = new Error('Token expired')
    sites.mockRejectedValue(failure)
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.loadSites()).rejects.toBe(failure)
  })
})
