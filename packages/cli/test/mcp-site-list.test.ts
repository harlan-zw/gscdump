import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGscMcpServer } from '../src/mcp/server'

// A fake account. `verified` holds the Sites that Google lists as owned.
const account = vi.hoisted(() => ({ verified: new Set<string>() }))

vi.mock('ofetch', () => ({
  ofetch: {
    create: () => (url: string, options: { method?: string } = {}) => {
      const target = String(url)
      if (target.endsWith('/webmasters/v3/sites')) {
        return Promise.resolve({
          siteEntry: ['sc-domain:example.com', 'https://new.com/'].map(siteUrl => ({
            siteUrl,
            permissionLevel: account.verified.has(siteUrl) ? 'siteOwner' : 'siteUnverifiedUser',
          })),
        })
      }
      if (target.endsWith('/siteVerification/v1/webResource') && options.method === 'POST') {
        account.verified.add('https://new.com/')
        return Promise.resolve({ id: 'https%3A%2F%2Fnew.com%2F', site: { type: 'SITE', identifier: 'https://new.com/' } })
      }
      if (target.includes('/siteVerification/v1/webResource/') && options.method === 'DELETE') {
        account.verified.delete('https://new.com/')
        return Promise.resolve(undefined)
      }
      if (target.endsWith('/sitemaps'))
        return Promise.resolve({ sitemap: [] })
      return Promise.reject(new Error(`Unexpected request: ${options.method ?? 'GET'} ${target}`))
    },
  },
}))

function text(result: CallToolResult): string {
  const item = result.content.find(entry => entry.type === 'text')
  return item?.type === 'text' ? item.text : ''
}

describe('mCP Site list cache', () => {
  let client: Client
  let server: ReturnType<typeof createGscMcpServer>

  const listSitemaps = async (siteUrl: string): Promise<CallToolResult> =>
    await client.callTool({ name: 'list-sitemaps', arguments: { siteUrl } }) as CallToolResult

  beforeEach(async () => {
    account.verified = new Set(['sc-domain:example.com'])
    server = createGscMcpServer({ getAuth: () => 'test-access-token' })
    client = new Client({ name: 'site-list-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it('resolves a Site after verify-site', async () => {
    expect((await listSitemaps('example.com')).isError).not.toBe(true)
    expect((await listSitemaps('new.com')).isError).toBe(true)

    const verified = await client.callTool({ name: 'verify-site', arguments: { siteUrl: 'https://new.com/', method: 'META' } }) as CallToolResult
    expect(verified.isError, text(verified)).not.toBe(true)

    const result = await listSitemaps('new.com')
    expect(result.isError, text(result)).not.toBe(true)
  })

  it('resolves every Site that list-sites shows', async () => {
    expect((await listSitemaps('example.com')).isError).not.toBe(true)
    // Verified outside this server, for example in the Search Console UI.
    account.verified.add('https://new.com/')

    const listed = JSON.parse(text(await client.callTool({ name: 'list-sites', arguments: {} }) as CallToolResult)) as { siteUrl: string }[]
    expect(listed.map(site => site.siteUrl)).toContain('https://new.com/')

    const result = await listSitemaps('new.com')
    expect(result.isError, text(result)).not.toBe(true)
  })

  it('rejects a Site after unverify-site', async () => {
    account.verified.add('https://new.com/')
    expect((await listSitemaps('new.com')).isError).not.toBe(true)

    const unverified = await client.callTool({ name: 'unverify-site', arguments: { id: 'https%3A%2F%2Fnew.com%2F' } }) as CallToolResult
    expect(unverified.isError, text(unverified)).not.toBe(true)

    expect((await listSitemaps('new.com')).isError).toBe(true)
  })
})
