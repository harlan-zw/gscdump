import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpCommand } from '../../src/commands/mcp'

const mocks = vi.hoisted(() => ({
  resolveBYOK: vi.fn(() => null),
  resolveAuth: vi.fn(),
  resolveServiceAccount: vi.fn(() => Promise.resolve(null)),
  loadTokens: vi.fn(),
  loadConfig: vi.fn(),
  createGscMcpServer: vi.fn(),
  serverConnect: vi.fn(),
}))

vi.mock('../../src/auth', () => ({
  resolveBYOK: mocks.resolveBYOK,
  resolveAuth: mocks.resolveAuth,
  resolveServiceAccount: mocks.resolveServiceAccount,
  loadTokens: mocks.loadTokens,
}))

vi.mock('../../src/config', () => ({
  loadConfig: mocks.loadConfig,
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
  })

  it('has correct metadata', () => {
    expect(mcpCommand.meta?.name).toBe('mcp')
    expect(mcpCommand.meta?.description).toContain('MCP')
  })

  it('exits with init instructions when no auth and no BYOK', async () => {
    mocks.resolveBYOK.mockReturnValue(null)
    mocks.loadConfig.mockResolvedValue({})
    mocks.loadTokens.mockResolvedValue(null)

    await mcpCommand.run!({ args: {}, rawArgs: [], cmd: mcpCommand } as any).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    const message = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(message).toContain('init')
    expect(mocks.createGscMcpServer).not.toHaveBeenCalled()
  })

  it('exits with login instructions when configured but no tokens', async () => {
    mocks.resolveBYOK.mockReturnValue(null)
    mocks.loadConfig.mockResolvedValue({ clientId: 'x', clientSecret: 'y' })
    mocks.loadTokens.mockResolvedValue(null)

    await mcpCommand.run!({ args: {}, rawArgs: [], cmd: mcpCommand } as any).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    const message = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(message).toContain('auth login')
  })

  it('starts the MCP server when BYOK is set', async () => {
    mocks.resolveBYOK.mockReturnValue('token-abc')

    await mcpCommand.run!({ args: {}, rawArgs: [], cmd: mcpCommand } as any)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(mocks.createGscMcpServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'gscdump',
      version: '1.0.0',
    }))
    const options = mocks.createGscMcpServer.mock.calls[0]![0] as { getAuth: () => Promise<unknown> }
    await expect(options.getAuth()).resolves.toBe('resolved-auth')
    expect(mocks.resolveAuth).toHaveBeenCalledWith({ interactive: false })
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
})
