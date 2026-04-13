import type { Auth } from 'gscdump'
import type { GscDriver } from 'gscdump/driver'
import type { HandlerContext } from '../types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { googleSearchConsole } from 'gscdump'
import { isCloudDriver } from 'gscdump/driver'
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
  /** Function to get auth for the current request context (used for local GSC API tools) */
  getAuth: () => Promise<Auth> | Auth
  /** Function to get the driver */
  getDriver: () => Promise<GscDriver>
}

export function createGscMcpServer(options: CreateGscMcpServerOptions): McpServer {
  const { name = 'gscdump', version = '1.0.0', getAuth, getDriver } = options

  const server = new McpServer({ name, version })

  const auth = async (): Promise<Auth> => Promise.resolve(getAuth())

  const getContext = async (): Promise<HandlerContext> => {
    const a = await auth()
    return {
      auth: a,
      client: googleSearchConsole(a),
    }
  }

  // === Shared tools (both modes) ===

  server.registerTool(
    'list-sites',
    {
      description: 'List all Google Search Console sites. In cloud mode, includes sync status and progress.',
      inputSchema: listSitesInput.shape,
    },
    async (_args) => {
      const driver = await getDriver()
      if (isCloudDriver(driver)) {
        const sites = await driver.sitesWithSync()
        return { content: [{ type: 'text', text: JSON.stringify(sites, null, 2) }] }
      }
      const sites = await driver.sites()
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
      const driver = await getDriver()
      const sitemaps = await driver.sitemaps(args.siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(sitemaps, null, 2) }] }
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
      const driver = await getDriver()
      const result = await driver.submitSitemap(args.siteUrl as string, args.feedpath as string)
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
      const driver = await getDriver()
      const result = await driver.deleteSitemap(args.siteUrl as string, args.feedpath as string)
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

  // Query tool (unified)
  server.registerTool(
    'query',
    {
      description: 'Run a custom search analytics query with specified dimensions. Works in both local and cloud mode.',
      inputSchema: z.object({
        siteUrl: z.string().describe('GSC property URL (e.g., sc-domain:example.com)'),
        startDate: z.string().describe('Start date (YYYY-MM-DD)'),
        endDate: z.string().describe('End date (YYYY-MM-DD)'),
        dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance'])).describe('Dimensions to group by'),
        rowLimit: z.number().optional().describe('Max rows (default 25000)'),
      }).shape,
    },
    async ({ siteUrl, startDate, endDate, dimensions, rowLimit }) => {
      const driver = await getDriver()
      const result = await driver.query(siteUrl as string, {
        startDate: startDate as string,
        endDate: endDate as string,
        dimensions: dimensions as string[],
        rowLimit: rowLimit as number | undefined,
      })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Analysis tool (unified)
  server.registerTool(
    'analysis',
    {
      description: 'Run SEO analysis (striking-distance, opportunity, movers, decay, zero-click, brand, cannibalization, clustering, concentration, seasonality). Works in both modes - local queries Google API directly, cloud uses synced data.',
      inputSchema: z.object({
        siteUrl: z.string().describe('GSC property URL'),
        tool: z.enum(['striking-distance', 'opportunity', 'movers', 'decay', 'zero-click', 'brand', 'cannibalization', 'clustering', 'concentration', 'seasonality']).describe('Analysis tool to run'),
        startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
        limit: z.number().optional().describe('Max results'),
        brandTerms: z.array(z.string()).optional().describe('Brand terms (required for brand analysis)'),
        prevStartDate: z.string().optional().describe('Previous period start (required for movers/decay)'),
        prevEndDate: z.string().optional().describe('Previous period end (required for movers/decay)'),
      }).shape,
    },
    async ({ siteUrl, tool, startDate, endDate, limit, brandTerms, prevStartDate, prevEndDate }) => {
      const driver = await getDriver()
      const result = await driver.analysis(siteUrl as string, {
        type: tool as any,
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
        limit: limit as number | undefined,
        brandTerms: brandTerms as string[] | undefined,
        prevStartDate: prevStartDate as string | undefined,
        prevEndDate: prevEndDate as string | undefined,
      })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Inspect URL (unified)
  server.registerTool(
    'inspect-url',
    {
      description: 'Inspect a URL to check its indexing status in Google Search Console',
      inputSchema: inspectUrlInput.shape,
    },
    async (args) => {
      const driver = await getDriver()
      const result = await driver.inspect(args.siteUrl as string, args.inspectionUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Indexing tools (local GSC API)
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

  // === Cloud-only tools ===
  // These check isCloudDriver at runtime and return helpful errors in local mode

  server.registerTool(
    'register-site',
    {
      description: 'Register a site for syncing on gscdump.com (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL to register (e.g., sc-domain:example.com)'),
      }).shape,
    },
    async ({ siteUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: register-site requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.registerSite(siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'sync-status',
    {
      description: 'Get detailed sync status for a site on gscdump.com (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
      }).shape,
    },
    async ({ siteUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: sync-status requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.syncStatus(siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'trigger-sync',
    {
      description: 'Trigger a fresh data sync for a site on gscdump.com (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
      }).shape,
    },
    async ({ siteUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: trigger-sync requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.triggerSync(siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'delete-site',
    {
      description: 'Unregister a site from gscdump.com (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
      }).shape,
    },
    async ({ siteUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: delete-site requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.deleteSite(siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'indexing',
    {
      description: 'Get indexing status trend and summary for a site (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
        days: z.number().optional().describe('Days of trend data (default 28, max 90)'),
      }).shape,
    },
    async ({ siteUrl, days }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: indexing requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.indexing(siteUrl as string, days ? { days: days as number } : undefined)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'indexing-diagnostics',
    {
      description: 'Get indexing issue diagnostics with counts and severity (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
      }).shape,
    },
    async ({ siteUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: indexing-diagnostics requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.indexingDiagnostics(siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'indexing-urls',
    {
      description: 'Get paginated URL list with indexing status details (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
        status: z.enum(['indexed', 'not_indexed', 'pending']).optional().describe('Filter by status'),
        issue: z.string().optional().describe('Filter by issue type'),
        search: z.string().optional().describe('Search URLs'),
        limit: z.number().optional().describe('Max results (default 100, max 500)'),
        offset: z.number().optional().describe('Pagination offset'),
      }).shape,
    },
    async ({ siteUrl, status, issue, search, limit, offset }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: indexing-urls requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.indexingUrls(siteUrl as string, {
        status: status as string | undefined,
        issue: issue as string | undefined,
        search: search as string | undefined,
        limit: limit as number | undefined,
        offset: offset as number | undefined,
      })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'index-percent',
    {
      description: 'Get index percent trend, invisible URLs, and orphan pages (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
      }).shape,
    },
    async ({ siteUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: index-percent requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.indexPercent(siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'sitemap-health',
    {
      description: 'Get sitemap health data with URL counts, error tracking, history (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
      }).shape,
    },
    async ({ siteUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: sitemap-health requires cloud mode. Run gscdump init to set up.' }] }
      const result = await driver.sitemapHealth(siteUrl as string)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'sitemap-action',
    {
      description: 'Submit, delete, or refresh sitemaps via gscdump.com (cloud mode only)',
      inputSchema: z.object({
        siteUrl: z.string().describe('Site URL'),
        action: z.enum(['submit', 'delete', 'refresh']).describe('Action to perform'),
        sitemapUrl: z.string().optional().describe('Sitemap URL (required for submit/delete)'),
      }).shape,
    },
    async ({ siteUrl, action, sitemapUrl }) => {
      const driver = await getDriver()
      if (!isCloudDriver(driver))
        return { content: [{ type: 'text', text: 'Error: sitemap-action requires cloud mode. Run gscdump init to set up.' }] }
      const body: { action: string, sitemapUrl?: string } = { action: action as string }
      if (sitemapUrl)
        body.sitemapUrl = sitemapUrl as string
      const result = await driver.sitemapAction(siteUrl as string, body)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  return server
}

export { McpServer }
