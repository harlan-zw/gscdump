import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpCommand } from '../../src/commands/mcp'

const mocks = vi.hoisted(() => ({
  resolveAuthentication: vi.fn(),
  resolveBYOK: vi.fn(() => null),
  resolveAuth: vi.fn(),
  resolveServiceAccount: vi.fn(() => Promise.resolve(null)),
  loadTokens: vi.fn(),
  loadConfig: vi.fn(),
  createGscMcpServer: vi.fn(),
  serverConnect: vi.fn(),
}))

vi.mock('../../src/auth-state', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/auth-state')>(),
  resolveAuthentication: mocks.resolveAuthentication,
}))

vi.mock('../../src/auth', () => ({
  resolveBYOK: mocks.resolveBYOK,
  resolveAuth: mocks.resolveAuth,
  resolveServiceAccount: mocks.resolveServiceAccount,
  loadTokens: mocks.loadTokens,
  probeAuth: async () => {
    if ((await mocks.resolveAuthentication())._tag === 'Cloud')
      return 'hosted'
    return mocks.resolveBYOK() || await mocks.resolveServiceAccount() || await mocks.loadTokens() ? 'google' : 'none'
  },
}))

vi.mock('../../src/config', () => ({
  loadConfig: mocks.loadConfig,
  loadResolvedConfig: async () => ({ config: await mocks.loadConfig() ?? {}, dataDir: '/tmp/gscdump-mcp-test' }),
}))

vi.mock('../../src/utils', () => ({
  VERSION: '1.0.0',
}))

vi.mock('../../src/mcp/server', () => ({
  createGscMcpServer: (...args: unknown[]) => {
    mocks.createGscMcpServer(...args)
    return { connect: mocks.serverConnect }
  },
}))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}))

describe('mcp command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveAuthentication.mockResolvedValue({ _tag: 'Local' })
    mocks.resolveServiceAccount.mockResolvedValue(null)
    mocks.resolveAuth.mockResolvedValue('resolved-auth')
    mocks.serverConnect.mockResolvedValue(undefined)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`)
    }) as never)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('has correct metadata', () => {
    expect(mcpCommand.meta?.name).toBe('mcp')
    expect(mcpCommand.meta?.description).toContain('MCP')
  })

  it('starts the MCP server when BYOK is set', async () => {
    mocks.resolveBYOK.mockReturnValue('token-abc')

    await mcpCommand.run!({ args: {}, rawArgs: [], cmd: mcpCommand } as any)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(mocks.createGscMcpServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'gscdump',
      version: '1.0.0',
    }))
    const options = mocks.createGscMcpServer.mock.calls[0]![0] as { getContext: () => Promise<unknown> }
    await expect(options.getContext()).resolves.toMatchObject({ auth: 'resolved-auth', authentication: { _tag: 'Local' } })
    expect(mocks.resolveAuth).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }))
    expect(mocks.serverConnect).toHaveBeenCalled()
  })

  it('starts the MCP server when service-account auth is configured', async () => {
    mocks.resolveServiceAccount.mockResolvedValue({ email: 'service@example.com' })
    mocks.resolveBYOK.mockReturnValue(null)

    await mcpCommand.run!({ args: {}, rawArgs: [], cmd: mcpCommand } as any)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(mocks.createGscMcpServer).toHaveBeenCalled()
    expect(mocks.loadConfig).not.toHaveBeenCalled()
    expect(mocks.loadTokens).not.toHaveBeenCalled()
  })

  it('starts the MCP server when saved tokens exist', async () => {
    mocks.resolveBYOK.mockReturnValue(null)
    mocks.loadConfig.mockResolvedValue({ clientId: 'x', clientSecret: 'y' })
    mocks.loadTokens.mockResolvedValue({ access_token: 't' })

    await mcpCommand.run!({ args: {}, rawArgs: [], cmd: mcpCommand } as any)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(mocks.createGscMcpServer).toHaveBeenCalled()
    expect(mocks.serverConnect).toHaveBeenCalled()
  })

  it('uses cloud authentication for later tools after the saved mode changes', async () => {
    mocks.resolveBYOK.mockReturnValue('local-google-token')
    await mcpCommand.run!({ args: {}, rawArgs: [], cmd: mcpCommand } as any)
    const options = mocks.createGscMcpServer.mock.calls[0]![0] as { getContext: () => Promise<{ client: { sites: () => Promise<unknown> } }> }
    mocks.resolveAuthentication.mockResolvedValue({ _tag: 'Cloud', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_changed' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])))
    const context = await options.getContext()
    expect(await context.client.sites()).toEqual([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    expect(fetch).toHaveBeenCalledWith('https://gscdump.com/api/cli/gsc/sites', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'gsd_user_changed' }) }))
    expect(mocks.resolveAuth).not.toHaveBeenCalled()
  })
})
