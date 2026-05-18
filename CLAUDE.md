# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CONSUMERS

- ~/sites/gscdump.com 
- ~/sites/nuxtseo.com 

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

Commands (full API parity with core lib):
- `gscdump init` - Full setup (auth + dataDir)
- `gscdump auth login|logout|status` - OAuth flow / status
- `gscdump config show|set|unset|path` - Manage configuration
- `gscdump sites [--with-sitemaps]` - List sites (optionally with sitemaps)
- `gscdump sitemaps list|get|submit|delete` - Sitemap CRUD
- `gscdump query` - Search analytics (local store + `--live`)
- `gscdump dump` - Export to file
- `gscdump inspect <url>` / `gscdump inspect batch` - URL inspection (single + batch)
- `gscdump indexing submit|remove|status|batch` - Indexing API
- `gscdump sync` - Sync GSC data into local store
- `gscdump store stats|compact|gc|export|rollups` - Local store ops
- `gscdump analyze <tool>` - Run analyzers (brand, movers, decay, ...)
- `gscdump entities` - Entity extraction
- `gscdump mcp` - Start MCP server

### BYOK (Bring Your Own Key)
The CLI runs without `init` if any of these env vars are set (also accept `GOOGLE_*` aliases):

- `GSC_ACCESS_TOKEN` - raw bearer token (e.g., from gcloud or another OAuth flow)
- `GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN` - OAuth refresh-token flow (no google-auth-library)

When BYOK is detected, `auth status` reports `byok` as the source and `auth login` is a no-op.

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
