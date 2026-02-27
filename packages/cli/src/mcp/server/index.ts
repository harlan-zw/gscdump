import type { Auth } from 'gscdump'
import type { CloudClient } from '../../cloud'
import type {
  HandlerContext,
} from '../types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { googleSearchConsole } from 'gscdump'
import { z } from 'zod'
import * as handlers from '../handlers'
import {
  batchInspectUrlsInput,
  batchRequestIndexingInput,
  customQueryInput,
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
  /** Function to get auth for the current request context */
  getAuth: () => Promise<Auth> | Auth
  /** Optional cloud client for platform features */
  cloudClient?: CloudClient | null
}

export function createGscMcpServer(options: CreateGscMcpServerOptions): McpServer {
  const { name = 'gscdump', version = '1.0.0', getAuth, cloudClient } = options

  const server = new McpServer({ name, version })

  // Helper to resolve auth with proper typing
  const auth = async (): Promise<Auth> => Promise.resolve(getAuth())

  const getContext = async (): Promise<HandlerContext> => {
    const a = await auth()
    return {
      auth: a,
      client: googleSearchConsole(a),
    }
  }

  // Sites tools
  server.registerTool(
    'list-sites',
    {
      description: 'List all Google Search Console sites the user has access to',
      inputSchema: listSitesInput.shape,
    },
    async (args) => {
      const result = await handlers.listSites(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
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
      const result = await handlers.listSitemaps(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Sitemap management tools
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
      const result = await handlers.submitSitemap(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'delete-sitemap',
    {
      description: 'Delete a sitemap from Google Search Console',
      inputSchema: sitemapInput.shape,
    },
    async (args) => {
      const result = await handlers.deleteSitemap(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Analytics tools
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
    'custom-query',
    {
      description: 'Run a custom search analytics query with specified dimensions',
      inputSchema: customQueryInput.shape,
    },
    async (args) => {
      const result = await handlers.customQuery(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Indexing tools
  server.registerTool(
    'inspect-url',
    {
      description: 'Inspect a URL in Google Search Console to check its indexing status',
      inputSchema: inspectUrlInput.shape,
    },
    async (args) => {
      const result = await handlers.inspectUrl(args, await getContext())
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

  // Cloud-only tools (when authenticated via gscdump.com)
  if (cloudClient) {
    const siteIdSchema = z.object({
      siteId: z.string().describe('Site ID from gscdump platform (use cloud-list-sites to find)'),
    })

    const analysisSchema = z.object({
      siteId: z.string().describe('Site ID from gscdump platform'),
      tool: z.enum(['striking-distance', 'opportunity', 'movers', 'decay', 'zero-click', 'brand', 'cannibalization', 'clustering', 'concentration', 'seasonality']).describe('Analysis tool to run'),
      startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
      limit: z.number().optional().describe('Max results'),
    })

    server.registerTool(
      'cloud-list-sites',
      {
        description: 'List registered sites on gscdump.com with sync status and progress',
        inputSchema: z.object({}).shape,
      },
      async () => {
        const result = await cloudClient.me()
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-sync-status',
      {
        description: 'Get detailed sync status for a site on gscdump.com',
        inputSchema: siteIdSchema.shape,
      },
      async ({ siteId }) => {
        const result = await cloudClient.syncStatus(siteId as string)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-sitemaps',
      {
        description: 'Get sitemap health data for a site from gscdump.com (includes URL counts, error tracking, history)',
        inputSchema: siteIdSchema.shape,
      },
      async ({ siteId }) => {
        const result = await cloudClient.sitemaps(siteId as string)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-analysis',
      {
        description: 'Run SEO analysis on synced data (striking-distance, opportunity, movers, decay, zero-click, brand, cannibalization, clustering, concentration, seasonality)',
        inputSchema: analysisSchema.shape,
      },
      async ({ siteId, tool, startDate, endDate, limit }) => {
        const params: Record<string, string> = {}
        if (startDate)
          params.startDate = startDate as string
        if (endDate)
          params.endDate = endDate as string
        if (limit)
          params.limit = String(limit)
        const result = await cloudClient.analysis(siteId as string, tool as string, params)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-register-site',
      {
        description: 'Register a site for syncing on gscdump.com',
        inputSchema: z.object({
          siteUrl: z.string().describe('Site URL to register (e.g., example.com)'),
        }).shape,
      },
      async ({ siteUrl }) => {
        const result = await cloudClient.registerSite(siteUrl as string)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-query',
      {
        description: 'Live GSC query via gscdump.com platform (bypasses synced data, queries Google directly)',
        inputSchema: z.object({
          siteId: z.string().describe('Site ID from gscdump platform'),
          startDate: z.string().describe('Start date (YYYY-MM-DD)'),
          endDate: z.string().describe('End date (YYYY-MM-DD)'),
          dimensions: z.string().optional().describe('Comma-separated: page,query,country,device,date,searchAppearance'),
          rowLimit: z.number().optional().describe('Max rows (default 1000, max 25000)'),
        }).shape,
      },
      async ({ siteId, startDate, endDate, dimensions, rowLimit }) => {
        const params: Record<string, string> = { startDate: startDate as string, endDate: endDate as string }
        if (dimensions)
          params.dimensions = dimensions as string
        if (rowLimit)
          params.rowLimit = String(rowLimit)
        const result = await cloudClient.query(siteId as string, params)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-indexing',
      {
        description: 'Get indexing status trend and summary for a site on gscdump.com',
        inputSchema: z.object({
          siteId: z.string().describe('Site ID from gscdump platform'),
          days: z.number().optional().describe('Days of trend data (default 28, max 90)'),
        }).shape,
      },
      async ({ siteId, days }) => {
        const params: Record<string, string> = {}
        if (days)
          params.days = String(days)
        const result = await cloudClient.indexing(siteId as string, params)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-indexing-diagnostics',
      {
        description: 'Get indexing issue diagnostics with counts and severity for a site',
        inputSchema: siteIdSchema.shape,
      },
      async ({ siteId }) => {
        const result = await cloudClient.indexingDiagnostics(siteId as string)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-indexing-urls',
      {
        description: 'Get paginated URL list with indexing status, verdict, and coverage details',
        inputSchema: z.object({
          siteId: z.string().describe('Site ID from gscdump platform'),
          status: z.enum(['indexed', 'not_indexed', 'pending']).optional().describe('Filter by status'),
          issue: z.string().optional().describe('Filter by issue type'),
          search: z.string().optional().describe('Search URLs'),
          limit: z.number().optional().describe('Max results (default 100, max 500)'),
          offset: z.number().optional().describe('Pagination offset'),
        }).shape,
      },
      async ({ siteId, status, issue, search, limit, offset }) => {
        const params: Record<string, string> = {}
        if (status)
          params.status = status as string
        if (issue)
          params.issue = issue as string
        if (search)
          params.search = search as string
        if (limit)
          params.limit = String(limit)
        if (offset)
          params.offset = String(offset)
        const result = await cloudClient.indexingUrls(siteId as string, params)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-index-percent',
      {
        description: 'Get index percent trend, invisible URLs (in sitemap but no traffic), and orphan pages (traffic but not in sitemap)',
        inputSchema: siteIdSchema.shape,
      },
      async ({ siteId }) => {
        const result = await cloudClient.indexPercent(siteId as string)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-trigger-sync',
      {
        description: 'Trigger a fresh data sync for a site on gscdump.com',
        inputSchema: siteIdSchema.shape,
      },
      async ({ siteId }) => {
        const result = await cloudClient.triggerSync(siteId as string)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-delete-site',
      {
        description: 'Unregister a site from gscdump.com (stops syncing, removes pending jobs)',
        inputSchema: siteIdSchema.shape,
      },
      async ({ siteId }) => {
        const result = await cloudClient.deleteSite(siteId as string)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )

    server.registerTool(
      'cloud-sitemap-action',
      {
        description: 'Submit, delete, or refresh sitemaps via gscdump.com',
        inputSchema: z.object({
          siteId: z.string().describe('Site ID from gscdump platform'),
          action: z.enum(['submit', 'delete', 'refresh']).describe('Action to perform'),
          sitemapUrl: z.string().optional().describe('Sitemap URL (required for submit/delete)'),
        }).shape,
      },
      async ({ siteId, action, sitemapUrl }) => {
        const body: { action: string, sitemapUrl?: string } = { action: action as string }
        if (sitemapUrl)
          body.sitemapUrl = sitemapUrl as string
        const result = await cloudClient.sitemapAction(siteId as string, body)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    )
  }

  return server
}

export { McpServer }
