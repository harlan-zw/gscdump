# @gscdump/cli

[![npm version](https://img.shields.io/npm/v/@gscdump/cli?color=yellow)](https://npmjs.com/package/@gscdump/cli)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/cli?color=yellow)](https://npm.chart.dev/@gscdump/cli)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> CLI for Google Search Console - dump, sync, compare, analyze, and run MCP server.

## Features

- **Data Export** - Dump analytics to stdout, file, or SQLite database
- **Period Comparison** - Compare metrics across time periods
- **SEO Analysis** - Striking distance, movers & shakers, decay detection
- **Indexing Tools** - Check status, request indexing, batch operations
- **MCP Server** - Let AI agents query your search data directly

## Install

```bash
npm install -g @gscdump/cli
# or run with npx
npx @gscdump/cli
```

## Quick Start

```bash
# First-run setup (choose cloud or local auth)
gscdump init

# List your sites
gscdump sites

# Dump last 7 days to stdout
gscdump dump --site https://example.com --period 7d

# Sync to SQLite database
gscdump sync --site https://example.com --db ./gsc.db

# Compare periods
gscdump compare --site https://example.com --period 28d

# Run SEO analysis
gscdump analyze striking-distance --site https://example.com
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | First-run setup (choose cloud/local mode) |
| `auth` | OAuth2 login with Google |
| `sites` | List GSC properties |
| `dump` | Export analytics to stdout/file |
| `sync` | Persist to SQLite database |
| `compare` | Period-over-period comparison |
| `analyze` | Run SEO analysis (striking-distance, movers, decay, etc.) |
| `sitemaps` | List/manage sitemaps for a site |
| `index` | URL indexing (status, inspect, request) |
| `inspect` | Quick URL inspection |
| `config` | Manage CLI configuration |
| `mcp` | Start MCP server for AI assistants |

## MCP Server

Start the MCP server for AI assistants:

```bash
gscdump mcp
```

Or add to your Claude config (`~/.claude.json` or VS Code settings):

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

Then ask Claude:
- "What pages lost traffic this week?"
- "Find keywords in striking distance (position 4-20)"
- "Which queries have keyword cannibalization?"
- "Compare this month vs last month"

## Auth Setup

**Cloud mode** (recommended):
```bash
gscdump init  # Select "cloud"
```
Easy setup via cloud.gscdump.com - no API keys needed.

**Local mode** (bring your own credentials):
1. Create a Google Cloud project
2. Enable "Search Console API" and "Web Search Indexing API"
3. Create OAuth2 credentials (Desktop app)
4. Run `gscdump init` and select "local"

## Related Packages

- [`gscdump`](../gscdump) - Core library
- [`@gscdump/mcp`](../mcp) - MCP server
- [`@gscdump/db`](../db) - SQLite persistence
- [`@gscdump/query`](../query) - Unified data provider

## License

[MIT](../../LICENSE)
