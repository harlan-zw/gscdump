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
}

export function createGscMcpServer(options: CreateGscMcpServerOptions): McpServer {
  const { name = 'gscdump', version = '1.0.0', getAuth } = options

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

  return server
}

export { McpServer }
