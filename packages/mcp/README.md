# @gscdump/mcp

[![npm version](https://img.shields.io/npm/v/@gscdump/mcp?color=yellow)](https://npmjs.com/package/@gscdump/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/mcp?color=yellow)](https://npm.chart.dev/@gscdump/mcp)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> MCP server for Google Search Console - let AI agents query your search data.

## Features

- **AI-Native Access** - Claude, Cursor, and other MCP clients can query GSC directly
- **Full Analytics** - Sites, pages, keywords, devices, countries, and search appearance
- **SEO Analysis** - Striking distance, movers & shakers, cannibalization, decay
- **Comparison Queries** - Period-over-period comparisons built-in

## Setup

Add to your Claude config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "gscdump": {
      "command": "npx",
      "args": ["@gscdump/mcp"]
    }
  }
}
```

Or for VS Code / Cursor, add to settings.json:

```json
{
  "mcp.servers": {
    "gscdump": {
      "command": "npx",
      "args": ["@gscdump/mcp"]
    }
  }
}
```

## Example Prompts

Once configured, ask your AI assistant:

- "What pages lost traffic this week?"
- "Find keywords in striking distance (position 4-20)"
- "Which queries have keyword cannibalization?"
- "Compare this month vs last month"
- "Show me the top 10 pages by clicks"
- "What's the CTR for mobile vs desktop?"

## Available Tools

The MCP server exposes tools for:

| Tool | Description |
|------|-------------|
| `gsc_sites` | List all GSC properties |
| `gsc_pages` | Query page-level metrics |
| `gsc_keywords` | Query keyword-level metrics |
| `gsc_devices` | Device breakdown (mobile/desktop/tablet) |
| `gsc_countries` | Country breakdown |
| `gsc_search_appearance` | Search appearance data |
| `gsc_analyze_*` | SEO analysis functions |

## Programmatic Usage

Use the handlers directly in your own MCP server:

```ts
import { createGscHandlers } from '@gscdump/mcp/handlers'

const handlers = createGscHandlers({
  auth: 'ya29.xxx...',
  defaultSite: 'https://example.com',
})

// Use in your MCP server
server.addTools(handlers.tools)
```

## Auth

The MCP server uses the same auth as the CLI. Run `npx @gscdump/cli init` first to set up authentication.

## Related Packages

- [`gscdump`](../gscdump) - Core library
- [`@gscdump/cli`](../cli) - CLI with `mcp` command
- [`@gscdump/db`](../db) - SQLite persistence
- [`@gscdump/query`](../query) - Unified data provider

## License

[MIT](../../LICENSE)
