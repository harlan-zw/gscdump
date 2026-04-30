import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpCommand } from '../../src/commands/mcp'

const mocks = vi.hoisted(() => ({
  resolveBYOK: vi.fn(() => null),
  loadTokens: vi.fn(),
  getAuth: vi.fn(),
  loadConfig: vi.fn(),
  createGscMcpServer: vi.fn(),
  serverConnect: vi.fn(),
}))

vi.mock('../../src/auth', () => ({
  resolveBYOK: mocks.resolveBYOK,
  loadTokens: mocks.loadTokens,
  getAuth: mocks.getAuth,
}))

vi.mock('../../src/config', () => ({
  loadConfig: mocks.loadConfig,
}))

vi.mock('../../src/utils', () => ({
  VERSION: '1.0.0',
}))

vi.mock('@gscdump/mcp/server', () => ({
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
    expect(mocks.serverConnect).toHaveBeenCalled()
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
