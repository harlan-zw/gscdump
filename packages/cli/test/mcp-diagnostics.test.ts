import { describe, expect, it, vi } from 'vitest'
import { diagnostics } from '../src/mcp/handlers/diagnostics'

const mocks = vi.hoisted(() => ({
  ofetch: vi.fn(),
  ofetchRaw: vi.fn(),
}))

vi.mock('ofetch', () => {
  const fn = (...args: unknown[]) => mocks.ofetch(...args)
  ;(fn as any).raw = (...args: unknown[]) => mocks.ofetchRaw(...args)
  return { ofetch: fn }
})

describe('mcp diagnostics', () => {
  it('accepts bare Google scope suffixes from tokeninfo', async () => {
    mocks.ofetch.mockResolvedValue({
      scope: 'webmasters indexing siteverification',
      email: 'user@example.com',
    })
    mocks.ofetchRaw.mockResolvedValue({
      headers: { get: () => new Date().toUTCString() },
    })

    const result = await diagnostics({} as any, {
      auth: 'token',
      client: {
        sites: vi.fn().mockResolvedValue([
          { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
        ]),
      },
    } as any)

    const scopes = result.checks.find(check => check.name === 'auth.scopes')
    expect(scopes?.status).toBe('pass')
  })
})
