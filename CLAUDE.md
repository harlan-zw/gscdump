# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## GSCDump

Google Search Console CLI and library. Real-time API queries, no local storage.

## Monorepo Structure

```
gscdump/
├── packages/
│   ├── gscdump/     # Core library - GSC API wrapper + query builder
│   └── cli/         # @gscdump/cli - CLI + MCP server
└── pnpm-workspace.yaml
```

Web app lives separately at https://github.com/harlan-zw/gscdump.com

## Build & Development

- **Build all**: `pnpm build`
- **Dev all**: `pnpm dev`
- **Test**: `pnpm test`
- **Lint**: `pnpm lint` / `pnpm lint:fix`
- **Typecheck**: `pnpm typecheck`

## Packages

### gscdump (Core)
GSC API wrapper with typed query builder. Pure functions, edge-compatible. Located at `packages/gscdump/src/`.

Key exports:
- `googleSearchConsole(auth)` - Create client
- `client.query(siteUrl, builder)` - Async generator for search analytics
- `client.sites()` - List sites
- `client.inspect()` - URL inspection
- `client.sitemaps.*` - Sitemap operations
- `client.indexing.*` - Indexing API

Query builder (`gscdump/query`):
- `gsc.select(page, query).where(between(date, start, end)).limit(1000)`
- Dimensions: `page`, `query`, `date`, `country`, `device`, `searchAppearance`
- Operators: `eq`, `contains`, `regex`, `between`, `and`, `or`, etc.

### @gscdump/cli
CLI + MCP server built with citty. Located at `packages/cli/src/`.

Commands:
- `gscdump init` - Set up authentication
- `gscdump dump` - Export search analytics
- `gscdump query` - Run custom queries
- `gscdump sites` - List sites
- `gscdump sitemaps` - Manage sitemaps
- `gscdump auth` - Manage authentication
- `gscdump config` - Manage configuration
- `gscdump mcp` - Start MCP server

MCP tools: `list-sites`, `fetch-pages`, `fetch-keywords`, `custom-query`, `inspect-url`, `request-indexing`, etc.

## Code Patterns

- **Functional**: Use functions, not classes
- **Error handling**: Use `.catch()` on promises, never try/catch
- **No backwards compat**: Delete unused code freely
- **ESM only**: All packages use `"type": "module"`
- **pnpm catalogs**: Dependencies versioned in `pnpm-workspace.yaml`

## Query Builder Usage

```ts
import { googleSearchConsole } from 'gscdump'
import { gsc, page, query, date, between } from 'gscdump/query'

const client = googleSearchConsole(auth)

const builder = gsc
  .select(page, query)
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(1000)

for await (const batch of client.query(siteUrl, builder)) {
  // Process rows
}
```
