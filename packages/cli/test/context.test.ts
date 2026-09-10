import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandContext } from '../src/context'

const sites = vi.hoisted(() => vi.fn())
vi.mock('gscdump/client', () => ({ googleSearchConsole: () => ({ sites }) }))
vi.mock('../src/auth', () => ({ resolveAuth: async () => 'token' }))
vi.mock('../src/auth-state', () => ({ resolveAuthentication: async () => ({ _tag: 'Local' }) }))
vi.mock('../src/config', () => ({ loadResolvedConfig: async () => ({ config: {}, dataDir: '/tmp/gscdump-context' }) }))

beforeEach(() => {
  sites.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('command Site selection', () => {
  it('rejects an unknown Site instead of selecting the only account Site', async () => {
    sites.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('sc-domain:missing.com')).rejects.toThrow(/No verified Site matches/)
  })

  it('rejects ambiguous shorthand instead of selecting the first match', async () => {
    sites.mockResolvedValue([
      { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://blog.example.com/', permissionLevel: 'siteOwner' },
    ])
    const ctx = await createCommandContext({ needsAuth: true })
    await expect(ctx.resolveSite('example.com')).rejects.toThrow(/Multiple Sites match/)
    await expect(ctx.resolveSite('https://example.com/')).resolves.toBe('https://example.com/')
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
