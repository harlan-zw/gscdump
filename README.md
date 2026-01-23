<h1>gscdump</h1>

[![npm version](https://img.shields.io/npm/v/gscdump?color=yellow)](https://npmjs.com/package/gscdump)
[![npm downloads](https://img.shields.io/npm/dm/gscdump?color=yellow)](https://npm.chart.dev/gscdump)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Talk to your Google Search Console with your favourite LLMs

<p align="center">
<table>
<tbody>
<td align="center">
<sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br> Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub><br>
</td>
</tbody>
</table>
</p>

## Features

- 💾 Own your data - export to any SQL database. No BigQuery, no 16-month expiry.
- 📊 Unlimited queries and row limits - GSC UI caps at 1k, API at 25k.
- 🤖 MCP Server - let Claude, Cursor, or any AI agent query your search data directly.
- 🔍 SEO analysis built-in - cannibalization, striking distance, movers & shakers, decay detection.
- ⚡ Indexing API - check index status, request indexing, batch operations.
- 🎯 Typed query builder - Drizzle-style API with streaming pagination.
- 🌐 Edge-compatible - works in Cloudflare Workers, Deno, etc.

## What is gscdump?

Google's export options are broken for developers. The UI caps at 1,000 rows, the API stops at 25k per request, and bulk export locks you into BigQuery. Worse, GSC deletes your data after 16 months.

With gscdump you get an MCP server that lets AI agents query your search data directly, a CLI for scripting and automation, built-in SEO analysis like keyword cannibalization and striking distance, plus indexing tools to check status and request indexing.

Export complete data with no row limits to any database you control. Your data, your infrastructure, forever.

## Get Started

```bash
# First-run setup
npx gscdump init

# List your sites
npx gscdump sites

# Export last 28 days
npx gscdump dump --site sc-domain:example.com

# Run custom query
npx gscdump query --site sc-domain:example.com --dimensions page,query

# Start MCP server
npx gscdump mcp
```

### Commands

| Command | Description |
|---------|-------------|
| `init` | Set up authentication (cloud or local) |
| `dump` | Export search analytics to stdout/file |
| `query` | Run custom queries with dimensions |
| `sites` | List GSC properties |
| `sitemaps` | List/manage sitemaps |
| `auth` | Manage authentication |
| `config` | Manage CLI configuration |
| `mcp` | Start MCP server for AI assistants |

## MCP Server

Add to your Claude config (`~/.claude.json` or VS Code settings):

```json
{
  "mcpServers": {
    "gscdump": {
      "command": "npx",
      "args": ["gscdump", "mcp"]
    }
  }
}
```

Then ask Claude:

- "What are my top pages this month?"
- "Show me keywords for my blog posts"
- "Check if this URL is indexed"
- "Request indexing for these new pages"

### MCP Tools

**Sites:** `list-sites`, `list-sites-with-sitemaps`, `list-sitemaps`, `get-sitemap`, `submit-sitemap`, `delete-sitemap`

**Analytics:** `fetch-pages`, `fetch-keywords`, `fetch-countries`, `fetch-devices`, `custom-query`

**Indexing:** `inspect-url`, `request-indexing`, `get-indexing-status`, `batch-request-indexing`, `batch-inspect-urls`

## API Usage

```ts
import { googleSearchConsole } from 'gscdump'
import { between, date, gsc, page, query } from 'gscdump/query'

// Create client with auth
const client = googleSearchConsole({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
})

// Build query
const builder = gsc
  .select(page, query)
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(10000)

// Stream results (async generator)
for await (const batch of client.query('sc-domain:example.com', builder)) {
  console.log(batch) // Array of { page, query, clicks, impressions, ctr, position }
}
```

### Query Builder

```ts
import { and, between, contains, country, date, device, eq, gsc, page, query } from 'gscdump/query'

const builder = gsc
  .select(page, query, device, country)
  .where(and(
    eq(device, 'MOBILE'),
    contains(page, '/blog/')
  ))
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(25000)

// Get raw API body
const body = builder.toBody()
```

**Dimensions:** `page`, `query`, `date`, `country`, `device`, `searchAppearance`

**Operators:** `eq`, `ne`, `contains`, `like`, `regex`, `notRegex`, `inArray`, `between`, `and`, `or`, `not`

### Other Client Methods

```ts
// List sites
const sites = await client.sites()

// Inspect URL
const { inspection, isIndexed } = await client.inspect(siteUrl, url)

// Sitemaps
const sitemaps = await client.sitemaps.list(siteUrl)
await client.sitemaps.submit(siteUrl, 'https://example.com/sitemap.xml')

// Indexing API
await client.indexing.publish(url, 'URL_UPDATED')
const metadata = await client.indexing.getMetadata(url)
```

## Auth Setup

**Cloud mode** (recommended):
```bash
npx gscdump init  # Select "cloud"
```
Easy setup via cloud.gscdump.com - no API keys needed.

**Local mode** (bring your own credentials):
1. Create a Google Cloud project
2. Enable "Search Console API" and "Web Search Indexing API"
3. Create OAuth2 credentials (Desktop app)
4. Run `npx gscdump init` and select "local"

**Environment variables:**
```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

## Packages

| Package | Description |
|---------|-------------|
| [`gscdump`](./packages/gscdump) | Core library - GSC API wrapper + query builder |
| [`@gscdump/cli`](./packages/cli) | CLI + MCP server |

## License

[MIT](./LICENSE)
