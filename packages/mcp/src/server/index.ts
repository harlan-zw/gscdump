import type { Auth } from 'gscdump'
import type { HandlerContext } from '../types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { googleSearchConsole } from 'gscdump'
import { z } from 'zod'
import * as handlers from '../handlers'
import {
  batchInspectUrlsInput,
  batchRequestIndexingInput,
  fetchAnalyticsInput,
  getIndexingStatusInput,
  inspectUrlInput,
  listSitemapsInput,
  listSitesInput,
  requestIndexingInput,
  sitemapInput,
} from '../types'

export interface CreateGscMcpServerOptions {
  name?: string
  version?: string
  getAuth: () => Promise<Auth> | Auth
}

export function createGscMcpServer(options: CreateGscMcpServerOptions): McpServer {
  const { name = 'gscdump', version = '1.0.0', getAuth } = options

  const server = new McpServer({ name, version })

  const auth = async (): Promise<Auth> => Promise.resolve(getAuth())

  const getContext = async (): Promise<HandlerContext> => {
    const a = await auth()
    return {
      auth: a,
      client: googleSearchConsole(a),
    }
  }

  const getClient = async (): Promise<ReturnType<typeof googleSearchConsole>> => googleSearchConsole(await auth())

  server.registerTool(
    'list-sites',
    {
      description: 'List all Google Search Console sites visible to the authenticated user.',
      inputSchema: listSitesInput.shape,
    },
    async () => {
      const client = await getClient()
      const raw = await client.sites()
      const sites = raw
        .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
        .map(s => ({ siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel || 'unknown' }))
      return { content: [{ type: 'text', text: JSON.stringify(sites, null, 2) }] }
    },
  )

  server.registerTool(
    'list-sites-with-sitemaps',
    {
      description: 'List all GSC sites with their sitemaps',
      inputSchema: listSitesInput.shape,
    },
    async (args) => {
      const result = await handlers.listSitesWithSitemaps(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'list-sitemaps',
    {
      description: 'List sitemaps for a specific site',
      inputSchema: listSitemapsInput.shape,
    },
    async (args) => {
      const client = await getClient()
      const sitemaps = await client.sitemaps.list(args.siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(sitemaps, null, 2) }] }
    },
  )

  server.registerTool(
    'get-sitemap',
    {
      description: 'Get details for a specific sitemap',
      inputSchema: sitemapInput.shape,
    },
    async (args) => {
      const result = await handlers.getSitemap(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'submit-sitemap',
    {
      description: 'Submit a sitemap to Google Search Console',
      inputSchema: sitemapInput.shape,
    },
    async (args) => {
      const client = await getClient()
      await client.sitemaps.submit(args.siteUrl as string, args.feedpath as string)
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] }
    },
  )

  server.registerTool(
    'delete-sitemap',
    {
      description: 'Delete a sitemap from Google Search Console',
      inputSchema: sitemapInput.shape,
    },
    async (args) => {
      const client = await getClient()
      await client.sitemaps.delete(args.siteUrl as string, args.feedpath as string)
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-pages',
    {
      description: 'Fetch page analytics data for a site',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchPages(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-keywords',
    {
      description: 'Fetch keyword/query analytics data for a site',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchKeywords(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-countries',
    {
      description: 'Fetch country analytics data for a site',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchCountries(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-devices',
    {
      description: 'Fetch device analytics data for a site',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchDevices(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'query',
    {
      description: 'Run a custom search analytics query with specified dimensions.',
      inputSchema: z.object({
        siteUrl: z.string().describe('GSC property URL (e.g., sc-domain:example.com)'),
        startDate: z.string().describe('Start date (YYYY-MM-DD)'),
        endDate: z.string().describe('End date (YYYY-MM-DD)'),
        dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance'])).describe('Dimensions to group by'),
        rowLimit: z.number().optional().describe('Max rows (default 25000)'),
      }).shape,
    },
    async ({ siteUrl, startDate, endDate, dimensions, rowLimit }) => {
      const client = await getClient()
      const limit = (rowLimit as number | undefined) ?? 25000
      const allRows: Record<string, unknown>[] = []
      let startRow = 0
      while (true) {
        const response = await client._rawQuery(siteUrl as string, {
          startDate: startDate as string,
          endDate: endDate as string,
          dimensions: dimensions as string[],
          rowLimit: limit,
          startRow,
        } as any)
        const rows = (response.rows || []).map((row) => {
          const result: Record<string, unknown> = {
            clicks: row.clicks ?? 0,
            impressions: row.impressions ?? 0,
            ctr: row.ctr ?? 0,
            position: row.position ?? 0,
          }
          ;(dimensions as string[]).forEach((dim, i) => {
            result[dim] = row.keys?.[i]
          })
          return result
        })
        allRows.push(...rows)
        if (rows.length < limit)
          break
        startRow += rows.length
      }
      return { content: [{ type: 'text', text: JSON.stringify({ siteUrl, rowCount: allRows.length, rows: allRows }, null, 2) }] }
    },
  )

  server.registerTool(
    'inspect-url',
    {
      description: 'Inspect a URL to check its indexing status in Google Search Console',
      inputSchema: inspectUrlInput.shape,
    },
    async (args) => {
      const client = await getClient()
      const result = await client.inspect(args.siteUrl as string, args.inspectionUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'request-indexing',
    {
      description: 'Request Google to index or remove a URL via the Indexing API',
      inputSchema: requestIndexingInput.shape,
    },
    async (args) => {
      const result = await handlers.requestIndexing(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'get-indexing-status',
    {
      description: 'Get indexing status metadata for a URL',
      inputSchema: getIndexingStatusInput.shape,
    },
    async (args) => {
      const result = await handlers.getIndexingStatus(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'batch-request-indexing',
    {
      description: 'Batch request indexing for multiple URLs with rate limiting',
      inputSchema: batchRequestIndexingInput.shape,
    },
    async (args) => {
      const result = await handlers.batchRequestIndexing(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'batch-inspect-urls',
    {
      description: 'Batch inspect multiple URLs to check their indexing status',
      inputSchema: batchInspectUrlsInput.shape,
    },
    async (args) => {
      const result = await handlers.batchInspectUrls(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  return server
}

export { McpServer }
