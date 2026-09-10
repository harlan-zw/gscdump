import type { ReportResult } from '@gscdump/engine/report'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGscMcpServer } from '../src/mcp/server'

const { apiQuery } = vi.hoisted(() => ({ apiQuery: vi.fn() }))

vi.mock('ofetch', () => ({ ofetch: { create: () => apiQuery } }))

const SITE = 'sc-domain:example.com'
const WINDOW = { period: 'custom', start: '2026-08-01', end: '2026-08-28' }

function readResult<T>(result: CallToolResult): T {
  const text = result.content.find(item => item.type === 'text')
  if (!text || text.type !== 'text')
    throw new Error('Expected a text response')
  expect(result.isError, text.text).not.toBe(true)
  return JSON.parse(text.text) as T
}

interface DiscoveredReport {
  id: string
  defaultPeriod: string
  defaultComparison: string
  argsSpec: Record<string, { type: string, required?: boolean, default?: unknown }>
}

describe('report discovery and execution over MCP', () => {
  let client: Client
  let server: ReturnType<typeof createGscMcpServer>
  let getAuth: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    apiQuery.mockReset().mockResolvedValue({ rows: [] })
    getAuth = vi.fn(() => 'test-access-token')
    server = createGscMcpServer({ getAuth })
    client = new Client({ name: 'report-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it('executes every advertised Report using its advertised input names', async () => {
    const reports = readResult<DiscoveredReport[]>(await client.callTool({ name: 'list-reports', arguments: {} }) as CallToolResult)
    expect(reports.map(report => report.id)).toEqual(expect.arrayContaining(['brand', 'pre-publish', 'movers']))
    for (const report of reports) {
      const params = Object.fromEntries(Object.entries(report.argsSpec).map(([name, arg]) => [
        name,
        arg.default ?? (arg.type === 'number' ? 1 : 'example'),
      ]))
      const result = readResult<ReportResult>(await client.callTool({
        name: 'run-report',
        arguments: { siteUrl: SITE, id: report.id, period: report.defaultPeriod, comparison: report.defaultComparison, ...params },
      }) as CallToolResult)
      expect(result.id).toBe(report.id)
      expect(result.meta.steps.some(step => step.status === 'done'), report.id).toBe(true)
      expect(result.sections.some(section => section.coverage === 'full'), report.id).toBe(true)
    }
  })

  it.each(['health', 'growth', 'triage'])('omits %s and rejects it before authentication or Google requests', async (id) => {
    const reports = readResult<DiscoveredReport[]>(await client.callTool({ name: 'list-reports', arguments: {} }) as CallToolResult)
    expect(reports.map(report => report.id)).not.toContain(id)
    const result = await client.callTool({ name: 'run-report', arguments: { siteUrl: SITE, id, target: 'example' } })
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('Use the CLI') }] })
    expect(getAuth).not.toHaveBeenCalled()
    expect(apiQuery).not.toHaveBeenCalled()
  })

  it('uses brandTerms and maxFindings to return the requested brand share', async () => {
    apiQuery.mockImplementation((_url, options) => Promise.resolve({
      rows: options.body.startRow > 0
        ? []
        : [
            { keys: ['Acme shoes', 'https://example.com/shoes'], clicks: 30, impressions: 300, ctr: 0.1, position: 7 },
            { keys: ['Acme boots', 'https://example.com/boots'], clicks: 10, impressions: 100, ctr: 0.1, position: 8 },
            { keys: ['plain socks', 'https://example.com/socks'], clicks: 60, impressions: 600, ctr: 0.1, position: 9 },
          ],
    }))
    const result = readResult<ReportResult>(await client.callTool({
      name: 'run-report',
      arguments: { siteUrl: SITE, id: 'brand', ...WINDOW, brandTerms: 'acme', maxFindings: 1 },
    }) as CallToolResult)
    expect(result.sections.find(section => section.id === 'brand-split')).toMatchObject({
      summary: { magnitudeLabel: 'brand share 40.0% (40 brand vs 60 non-brand clicks)' },
      findings: [{ entity: { kind: 'query', value: 'Acme shoes' }, metrics: { clicks: 30 } }],
    })
  })

  it('uses topic to select pre-publish findings', async () => {
    apiQuery.mockImplementation((_url, options) => Promise.resolve({
      rows: options.body.startRow > 0
        ? []
        : [
            { keys: ['running shoes', 'https://example.com/shoes'], clicks: 3, impressions: 300, ctr: 0.01, position: 7 },
            { keys: ['plain socks', 'https://example.com/socks'], clicks: 6, impressions: 600, ctr: 0.01, position: 9 },
          ],
    }))
    const result = readResult<ReportResult>(await client.callTool({
      name: 'run-report',
      arguments: { siteUrl: SITE, id: 'pre-publish', ...WINDOW, topic: 'shoes' },
    }) as CallToolResult)
    expect(result.sections.find(section => section.id === 'striking-peers')?.findings).toMatchObject([
      { entity: { kind: 'query', value: 'running shoes' } },
    ])
  })

  it('uses minClicksChange to filter movers findings', async () => {
    apiQuery.mockImplementation((_url, options) => Promise.resolve({
      rows: options.body.startRow > 0
        ? []
        : [{
            keys: ['running shoes', 'https://example.com/shoes'],
            clicks: options.body.startDate === WINDOW.start ? 30 : 10,
            impressions: 300,
            ctr: 0.1,
            position: 7,
          }],
    }))
    const run = async (minClicksChange: number) => readResult<ReportResult>(await client.callTool({
      name: 'run-report',
      arguments: { siteUrl: SITE, id: 'movers', ...WINDOW, minClicksChange },
    }) as CallToolResult)
    const visible = await run(5)
    const filtered = await run(50)
    expect(visible.sections.find(section => section.id === 'rising')?.findings).toMatchObject([
      { entity: { kind: 'query', value: 'running shoes' } },
    ])
    expect(filtered.sections.find(section => section.id === 'rising')?.findings).toEqual([])
  })
})
