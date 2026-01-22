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
  // cannibalizationInput,
  // contentDecayInput,
  // customQueryInput,
  // fetchAnalyticsInput,
  // fetchKeywordInput,
  // fetchPageInput,
  getIndexingStatusInput,
  inspectUrlInput,
  listSitemapsInput,
  listSitesInput,
  // moversAndShakersInput,
  requestIndexingInput,
  sitemapInput,
  // strikingDistanceInput,
  // yoyComparisonInput,
  // zeroClickInput,
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

  // TODO: Restore analytics tools once gscdump fetch* functions are re-implemented
  // Analytics tools are temporarily disabled

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

  // TODO: Restore analysis tools once gscdump fetch* functions are re-implemented
  // Analysis tools are temporarily disabled

  return server
}

export { McpServer }
