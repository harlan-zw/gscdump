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

  it('refreshes the token, posts it, and keeps it out of every check', async () => {
    const secret = 'ya29.mcp-secret-token'
    mocks.ofetch.mockRejectedValue(new Error(`[POST] "https://oauth2.googleapis.com/tokeninfo": 400 Invalid token ${secret}`))
    mocks.ofetchRaw.mockResolvedValue({ headers: { get: () => new Date().toUTCString() } })
    const getAccessToken = vi.fn().mockResolvedValue({ token: secret })

    const result = await diagnostics({} as any, {
      auth: { getAccessToken },
      client: { sites: vi.fn().mockRejectedValue(new Error(`401 for access_token=${secret}`)) },
    } as any)

    expect(getAccessToken).toHaveBeenCalledOnce()
    expect(mocks.ofetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/tokeninfo', expect.objectContaining({ method: 'POST' }))
    expect(result.checks.find(check => check.name === 'auth')).toMatchObject({ status: 'fail' })
    expect(JSON.stringify(result)).not.toContain('mcp-secret-token')
  })
})
