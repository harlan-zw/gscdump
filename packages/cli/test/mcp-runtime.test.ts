import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startMcpServer } from '../src/commands/mcp'
import { createCliRuntime } from '../src/runtime'

// The shared setup file mocks ofetch; these tests drive the real client over a stubbed fetch.
vi.mock('ofetch', async () => await vi.importActual('ofetch'))

type Route = (url: string, init: RequestInit) => Response | undefined

const SITES = { siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] }

function googleError(status: number, message: string, reason?: string): Response {
  return Response.json({
    error: {
      code: status,
      message,
      ...(reason ? { errors: [{ reason, message }] } : {}),
    },
  }, { status })
}

function text(result: CallToolResult): string {
  const item = result.content.find(entry => entry.type === 'text')
  return item?.type === 'text' ? item.text : ''
}

describe('gscdump mcp runtime', () => {
  let configDir: string
  let client: Client
  let fetchMock: ReturnType<typeof vi.fn>

  async function connect(route: Route = () => undefined, environment: Record<string, string> = {}): Promise<void> {
    fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input)
      return route(url, init)
        ?? (url.endsWith('/webmasters/v3/sites') ? Response.json(SITES) : Response.json({}))
    })
    vi.stubGlobal('fetch', fetchMock)
    const runtime = createCliRuntime({ configDir, environment, rawArgs: ['mcp'] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    // Start outside any runtime context, as stdin events arrive in production.
    await startMcpServer(serverTransport, runtime)
    client = new Client({ name: 'runtime-test', version: '1.0.0' })
    await client.connect(clientTransport)
  }

  async function saveTokens(accessToken: string): Promise<void> {
    await fs.writeFile(path.join(configDir, 'tokens.json'), JSON.stringify({
      provider: 'gscdump',
      access_token: accessToken,
      refresh_token: 'refresh-token',
      expiry_date: Date.now() + 3_600_000,
    }))
  }

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-mcp-runtime-'))
  })

  afterEach(async () => {
    await client?.close()
    vi.unstubAllGlobals()
    await fs.rm(configDir, { recursive: true, force: true })
  })

  it('uses the tokens in the config dir of the invocation', async () => {
    await saveTokens('token-from-config-dir')
    await connect()

    const result = await client.callTool({ name: 'list-sites', arguments: {} }) as CallToolResult

    expect(result.isError, text(result)).not.toBe(true)
    expect(JSON.parse(text(result))).toEqual([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer token-from-config-dir')
  })

  it('falls back to saved tokens when the service-account pointer is broken', async () => {
    await saveTokens('token-beside-broken-pointer')
    await connect(undefined, { GOOGLE_APPLICATION_CREDENTIALS: path.join(configDir, 'missing-key.json') })

    const result = await client.callTool({ name: 'list-sites', arguments: {} }) as CallToolResult

    expect(result.isError, text(result)).not.toBe(true)
    expect(JSON.parse(text(result))).toEqual([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer token-beside-broken-pointer')
  })

  it('points a hosted 401 at GSCDUMP_API_KEY, not the local login flow', async () => {
    await connect(
      url => url.endsWith('/cli/gsc/sites')
        ? Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })
        : undefined,
      { GSCDUMP_API_KEY: 'gsd_user_test' },
    )

    const result = await client.callTool({ name: 'list-sites', arguments: {} }) as CallToolResult

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('GSCDUMP_API_KEY')
    expect(text(result)).not.toContain('gscdump auth login')
  })

  it('points an expired BYOK access token at the MCP server configuration, not auth login', async () => {
    await connect(
      url => url.endsWith('/webmasters/v3/sites')
        ? googleError(401, 'Request had invalid authentication credentials.')
        : undefined,
      { GSC_ACCESS_TOKEN: 'stale-token' },
    )

    const result = await client.callTool({ name: 'list-sites', arguments: {} }) as CallToolResult

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('GSC_ACCESS_TOKEN')
    expect(text(result)).toContain('MCP server configuration')
    expect(text(result)).not.toContain('gscdump auth login')
  })

  it('surfaces the service-account diagnostic when it is the only credential configured', async () => {
    const keyPath = path.join(configDir, 'oauth-client.json')
    await fs.writeFile(keyPath, JSON.stringify({ type: 'authorized_user' }))
    await connect(undefined, { GSC_SERVICE_ACCOUNT_JSON: keyPath })

    const result = await client.callTool({ name: 'list-sites', arguments: {} }) as CallToolResult

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not a service-account key')
    expect(text(result)).toContain('GSC_SERVICE_ACCOUNT_JSON')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starts without authentication and returns the next command from a tool call', async () => {
    await connect()

    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toContain('list-sites')

    const result = await client.callTool({ name: 'list-sites', arguments: {} }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('gscdump auth login')
    expect(text(result)).toContain('GSCDUMP_API_KEY')
    expect(text(result)).toContain('GSC_ACCESS_TOKEN')
    expect(text(result)).not.toMatch(/GSCDump|npx/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a Google permission failure to the agent with a next step', async () => {
    await saveTokens('token')
    await connect(url => url.includes('/sitemaps')
      ? googleError(403, 'User does not have sufficient permission for site \'sc-domain:example.com\'.')
      : undefined)

    const result = await client.callTool({ name: 'list-sitemaps', arguments: { siteUrl: 'example.com' } }) as CallToolResult

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not have sufficient permission')
    expect(text(result)).toContain('gscdump auth status')
    expect(text(result)).not.toContain('\n')
  })

  it('reports a Google quota failure as a wait, not a permission problem', async () => {
    await saveTokens('token')
    await connect(url => url.includes('/searchAnalytics/query')
      ? googleError(403, 'Search Analytics load quota exceeded.', 'quotaExceeded')
      : undefined)

    // One retry waits 5s on the real clock. The CLI default backoff (65s)
    // outlasts both this test's timeout and the MCP client's 60s request timeout.
    const result = await client.callTool({
      name: 'query',
      arguments: { siteUrl: 'example.com', startDate: '2026-08-01', endDate: '2026-08-28', dimensions: ['query'] },
    }) as CallToolResult

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('quota exceeded')
    expect(text(result)).toMatch(/Try again/)
    expect(text(result)).not.toContain('gscdump auth status')
  })
})
