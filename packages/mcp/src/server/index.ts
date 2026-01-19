import type { Auth } from 'gscdump'
import type {
  HandlerContext,
} from '../types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { googleSearchConsole } from 'gscdump'
import * as handlers from '../handlers'
import {
  batchInspectUrlsInput,
  batchRequestIndexingInput,
  cannibalizationInput,
  contentDecayInput,
  customQueryInput,
  fetchAnalyticsInput,
  fetchKeywordInput,
  fetchPageInput,
  getIndexingStatusInput,
  inspectUrlInput,
  listSitemapsInput,
  listSitesInput,
  moversAndShakersInput,
  periodRangeInput,
  requestIndexingInput,
  sitemapInput,
  strikingDistanceInput,
  yoyComparisonInput,
  zeroClickInput,
} from '../types'

export interface CreateGscMcpServerOptions {
  name?: string
  version?: string
  /** Function to get auth for the current request context */
  getAuth: () => Promise<Auth> | Auth
  /** Optional function to get database for local queries */
  getDb?: () => Promise<import('@gscdump/db').GscDb | null> | import('@gscdump/db').GscDb | null
}

export function createGscMcpServer(options: CreateGscMcpServerOptions): McpServer {
  const { name = 'gscdump', version = '1.0.0', getAuth, getDb } = options

  const server = new McpServer({ name, version })

  // Helper to resolve auth with proper typing
  const auth = async (): Promise<Auth> => Promise.resolve(getAuth())

  const getContext = async (): Promise<HandlerContext> => {
    const a = await auth()
    const db = getDb ? await Promise.resolve(getDb()) : null
    return {
      auth: a,
      client: googleSearchConsole(a),
      db,
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
    'fetch-dates',
    {
      description: 'Fetch daily search analytics data with optional period comparison',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchDates(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-devices',
    {
      description: 'Fetch device breakdown (desktop, mobile, tablet) with comparison',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchDevices(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-countries',
    {
      description: 'Fetch top countries by traffic with comparison',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchCountries(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-pages',
    {
      description: 'Fetch all pages with performance data',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchAllPages(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-pages-comparison',
    {
      description: 'Fetch page performance with period comparison',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchPagesComparison(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-keywords',
    {
      description: 'Fetch keyword performance with period comparison',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchKeywords(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-search-appearance',
    {
      description: 'Fetch search appearance breakdown (AMP, rich results, etc.)',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchSearchAppearance(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-page-details',
    {
      description: 'Fetch detailed data for a specific page including daily trends and top keywords',
      inputSchema: fetchPageInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchPageDetails(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-keyword-details',
    {
      description: 'Fetch detailed data for a specific keyword including daily trends and top pages',
      inputSchema: fetchKeywordInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchKeywordDetails(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-analytics-summary',
    {
      description: 'Fetch overall site analytics summary with keyword data and period comparison',
      inputSchema: fetchAnalyticsInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchAnalyticsSummary(args, await getContext())
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

  // Analysis tools
  server.registerTool(
    'detect-cannibalization',
    {
      description: 'Find queries ranking for multiple pages (keyword cannibalization)',
      inputSchema: cannibalizationInput.shape,
    },
    async (args) => {
      const result = await handlers.detectCannibalization(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'find-striking-distance',
    {
      description: 'Find quick-win keywords (position 4-20, high impressions, low CTR)',
      inputSchema: strikingDistanceInput.shape,
    },
    async (args) => {
      const result = await handlers.findStrikingDistance(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'fetch-yoy-comparison',
    {
      description: 'Year-over-year metrics comparison',
      inputSchema: yoyComparisonInput.shape,
    },
    async (args) => {
      const result = await handlers.fetchYoYComparison(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'analyze-movers-and-shakers',
    {
      description: 'Identify trending queries (rising and declining)',
      inputSchema: moversAndShakersInput.shape,
    },
    async (args) => {
      const result = await handlers.analyzeMoversAndShakers(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'detect-content-decay',
    {
      description: 'Identify decaying content (pages losing traffic vs previous year)',
      inputSchema: contentDecayInput.shape,
    },
    async (args) => {
      const result = await handlers.detectContentDecay(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'find-zero-click-queries',
    {
      description: 'Identify zero-click queries (high impressions, low CTR in top positions)',
      inputSchema: zeroClickInput.shape,
    },
    async (args) => {
      const result = await handlers.findZeroClickQueries(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Query tool
  server.registerTool(
    'custom-query',
    {
      description: 'Execute a custom GSC search analytics query with specified dimensions',
      inputSchema: customQueryInput.shape,
    },
    async (args) => {
      const result = await handlers.customQuery(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Utility tools
  server.registerTool(
    'parse-period',
    {
      description: 'Parse period strings (30d, 3mo, max) to date ranges with comparison period',
      inputSchema: periodRangeInput.shape,
    },
    (args) => {
      const result = handlers.parsePeriod(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  return server
}

export { McpServer }
