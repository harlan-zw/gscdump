# Architecture

## Monorepo Structure

```
gscdump/
├── packages/
│   ├── gscdump/     # Core library - GSC API wrapper + query builder
│   └── cli/         # CLI + MCP server
└── pnpm-workspace.yaml
```

Web app lives separately at https://github.com/harlan-zw/gscdump.com

## Packages

### gscdump (Core Library)

Google Search Console API wrapper with typed query builder. Pure functions, **edge-compatible** (works in Cloudflare Workers, Deno, etc).

```
packages/gscdump/src/
├── index.ts              # Public API exports
├── core/
│   ├── client.ts         # ofetch-based GSC/Indexing API client
│   ├── errors.ts         # Error handling utilities
│   └── types.ts          # Core TypeScript interfaces
├── api/
│   ├── indexing.ts       # Indexing API requests
│   ├── inspection.ts     # URL inspection APIs
│   └── sites.ts          # Site/sitemap listing APIs
└── query/
    ├── index.ts          # Query builder exports
    ├── builder.ts        # Fluent query builder
    ├── columns.ts        # Dimension column definitions
    ├── constants.ts      # Device/Country/SearchType enums
    ├── operators.ts      # Filter operators (eq, contains, etc.)
    ├── resolver.ts       # Query resolution to API body
    ├── types.ts          # Query types
    └── utils/
        ├── countries.ts  # ISO country code mappings
        ├── dayjs.ts      # Configured dayjs with PST timezone
        └── format.ts     # Date formatting utilities
```

**Authentication:**

```ts
import { googleSearchConsole } from 'gscdump'

// Token string
const client = googleSearchConsole('ya29.xxx...')

// Or object with accessToken
const client = googleSearchConsole({ accessToken: 'ya29.xxx...' })

// Or OAuth credentials (auto-refreshes)
const client = googleSearchConsole({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
})
```

**Client Methods:**

| Method | Purpose |
|--------|---------|
| `client.query(siteUrl, builder)` | Async generator for search analytics |
| `client.sites()` | List all GSC properties |
| `client.inspect(siteUrl, url)` | Check URL indexing status |
| `client.sitemaps.list(siteUrl)` | List sitemaps |
| `client.sitemaps.get(siteUrl, feedpath)` | Get sitemap details |
| `client.sitemaps.submit(siteUrl, feedpath)` | Submit sitemap |
| `client.sitemaps.delete(siteUrl, feedpath)` | Delete sitemap |
| `client.indexing.publish(url, type)` | Request indexing |
| `client.indexing.getMetadata(url)` | Get indexing metadata |
| `client._rawQuery(siteUrl, body)` | Low-level query (internal) |

**Helper Functions:**

| Function | Purpose |
|----------|---------|
| `fetchSites(client)` | List all GSC properties |
| `fetchSitesWithSitemaps(client)` | Properties + sitemaps |
| `fetchSitemaps(client, siteUrl)` | Sitemaps for a site |
| `fetchSitemap(client, siteUrl, feedpath)` | Single sitemap |
| `submitSitemap(client, siteUrl, feedpath)` | Submit sitemap |
| `deleteSitemap(client, siteUrl, feedpath)` | Delete sitemap |
| `inspectUrl(client, siteUrl, url)` | URL inspection |
| `batchInspectUrls(client, siteUrl, urls, opts?)` | Batch inspection |
| `requestIndexing(client, url, opts?)` | Request indexing |
| `getIndexingMetadata(client, url)` | Indexing metadata |
| `batchRequestIndexing(client, urls, opts?)` | Batch indexing |

**Error Utilities:**

| Function | Purpose |
|----------|---------|
| `isQuotaError(error)` | Check if quota exceeded |
| `isRateLimitError(error)` | Check if rate limited |
| `isAuthError(error)` | Check if auth failure |
| `getErrorCode(error)` | Extract HTTP status |
| `getErrorMessage(error)` | Extract error message |
| `getRetryAfter(error)` | Get retry-after seconds |
| `analyzeError(error)` | Full error analysis |
| `formatErrorForCli(error)` | CLI-friendly message |

**Query Builder (`gscdump/query`):**

```ts
import { and, between, contains, date, eq, gsc, page, query } from 'gscdump/query'

const builder = gsc
  .select(page, query, date)
  .where(and(
    eq(device, 'MOBILE'),
    contains(page, '/blog/')
  ))
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(25000)

// Use with client
for await (const batch of client.query(siteUrl, builder)) {
  // Process batch of rows
}

// Or get raw API body
const body = builder.toBody()
```

**Dimensions:** `page`, `query`, `date`, `country`, `device`, `searchAppearance`

**Operators:**

| Operator | Type Narrowing | Description |
|----------|----------------|-------------|
| `eq(col, val)` | ✓ | Exact match |
| `ne(col, val)` | ✗ | Not equal |
| `inArray(col, [a, b])` | ✓ | Value in array |
| `contains(col, str)` | ✗ | String contains |
| `like(col, '%pattern%')` | ✗ | SQL LIKE pattern |
| `regex(col, /pattern/)` | ✗ | Regex match |
| `notRegex(col, /pattern/)` | ✗ | Regex not match |
| `between(col, start, end)` | ✗ | Range (dates) |
| `and(...filters)` | ✓ | Merge constraints |
| `or(...filters)` | ✗ | Any match |
| `not(filter)` | ✗ | Invert filter |

### @gscdump/cli

Command-line interface with built-in MCP server.

```
packages/cli/src/
├── index.ts              # Main entry, command registration
├── auth.ts               # OAuth2 flows (local + cloud)
├── config.ts             # Config file handling
├── utils.ts              # Progress bars, CSV export
├── commands/
│   ├── init.ts           # First-run setup
│   ├── dump.ts           # Export to JSON/CSV
│   ├── query.ts          # Custom queries
│   ├── sites.ts          # List GSC properties
│   ├── sitemaps.ts       # Sitemap management
│   ├── auth.ts           # Auth status/logout
│   ├── config.ts         # Config management
│   └── mcp.ts            # Start MCP server
└── mcp/
    ├── index.ts          # MCP exports
    ├── types.ts          # Zod input schemas
    ├── server/
    │   └── index.ts      # createGscMcpServer factory
    └── handlers/
        ├── analytics.ts  # Analytics fetch handlers
        ├── indexing.ts   # URL inspection/indexing
        ├── query.ts      # Custom query handler
        ├── sites.ts      # Site/sitemap handlers
        └── utils.ts      # Period parsing
```

**Commands:**

| Command | Purpose |
|---------|---------|
| `gscdump init` | First-run setup (cloud/local mode) |
| `gscdump dump` | Export search analytics |
| `gscdump query` | Run custom queries |
| `gscdump sites` | List GSC properties |
| `gscdump sitemaps` | Manage sitemaps |
| `gscdump auth` | Manage authentication |
| `gscdump config` | Manage configuration |
| `gscdump mcp` | Start MCP server |

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `list-sites` | List all GSC properties |
| `list-sites-with-sitemaps` | Sites with sitemaps |
| `list-sitemaps` | Sitemaps for a site |
| `get-sitemap` | Sitemap details |
| `submit-sitemap` | Submit sitemap |
| `delete-sitemap` | Delete sitemap |
| `fetch-pages` | Page analytics |
| `fetch-keywords` | Keyword analytics |
| `fetch-countries` | Country analytics |
| `fetch-devices` | Device analytics |
| `custom-query` | Custom dimension query |
| `inspect-url` | URL indexing status |
| `request-indexing` | Request indexing |
| `get-indexing-status` | Indexing metadata |
| `batch-request-indexing` | Batch indexing |
| `batch-inspect-urls` | Batch inspection |

## Data Flow

```
Auth (token or OAuth credentials)
     │
     ▼
┌─────────────────────────────────────┐
│           gscdump (core)            │
│  client.ts: googleSearchConsole()   │
│  query/: typed query builder        │
│  api/: sites, indexing, inspection  │
└─────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────┐
│           @gscdump/cli              │
│  commands: dump, query, sites, etc. │
│  mcp/: MCP server for AI assistants │
└─────────────────────────────────────┘
```

## Key Patterns

### Streaming Pagination

GSC limits responses to 25k rows. The client's `query()` method handles pagination automatically via async generator:

```ts
for await (const batch of client.query(siteUrl, builder)) {
  // Each batch is up to rowLimit rows (default 25k)
  // Generator continues until all data is fetched
}
```

### Query Builder

The `gscdump/query` module provides a fluent, type-safe query builder:

```ts
import { between, date, gsc, page, query } from 'gscdump/query'

const builder = gsc
  .select(page, query) // Dimensions to include
  .where(between(date, start, end)) // Filters
  .limit(10000) // Max rows per batch

const body = builder.toBody() // Get raw API body
```

### Error Handling

Uses `.catch()` on promises per project convention. No try/catch blocks.

```ts
await client.sites()
  .catch((err) => {
    if (isQuotaError(err)) {
      console.log('Quota exceeded, try tomorrow')
    }
  })
```

## Dependencies

### gscdump (core)

| Package | Purpose |
|---------|---------|
| `ofetch` | HTTP client (edge-compatible) |
| `dayjs` | Date manipulation |

### @gscdump/cli

| Package | Purpose |
|---------|---------|
| `gscdump` | Core library |
| `@modelcontextprotocol/sdk` | MCP SDK |
| `google-auth-library` | OAuth2 flows |
| `citty` | CLI framework |
| `@clack/prompts` | Interactive prompts |
| `consola` | Logging |
| `zod` | Schema validation (MCP) |

## Build System

- **obuild**: TypeScript build tool for all packages
- **pnpm catalogs**: Centralized dependency versions in `pnpm-workspace.yaml`
- **ESM only**: All packages use `"type": "module"`
