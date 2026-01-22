# AI Integration

Let Claude, Cursor, or any MCP-compatible AI query your Search Console data directly.

## Quick Setup

### Claude Desktop

Add to `~/.claude.json`:

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

### Claude Code

Add to `.mcp.json` in your project:

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

### VS Code / Cursor

Add to your MCP settings:

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

Once configured, ask Claude:

### Traffic Analysis
- "What pages lost the most traffic this week?"
- "Show me my top 10 keywords by clicks"
- "Compare this month vs last month"
- "Which countries drive the most traffic?"

### Quick Wins
- "Find keywords in striking distance (position 4-20)"
- "What keywords have high impressions but low CTR?"
- "Show opportunities to improve rankings"

### Content Issues
- "Which queries have keyword cannibalization?"
- "Find pages with declining traffic"
- "What content is decaying?"

### Indexing
- "Check if /blog/new-post is indexed"
- "Request indexing for these URLs: ..."
- "Show pages with indexing issues"

## Available MCP Tools

The MCP server exposes these tools:

| Tool | Description |
|------|-------------|
| `list-sites` | List GSC properties |
| `fetch-pages` | Get page performance data |
| `fetch-keywords` | Get keyword data with comparison |
| `fetch-devices` | Device breakdown |
| `fetch-countries` | Country breakdown |
| `find-striking-distance` | Quick-win keywords |
| `detect-cannibalization` | Cannibalization analysis |
| `analyze-movers-and-shakers` | Rising/declining queries |
| `detect-content-decay` | Decaying content |
| `inspect-url` | Check URL index status |
| `request-indexing` | Request URL indexing |
| `custom-query` | Execute custom GSC query |

## With Database Backend

For faster responses and historical queries, connect a database:

```json
{
  "mcpServers": {
    "gscdump": {
      "command": "npx",
      "args": ["@gscdump/mcp"],
      "env": {
        "GSCDUMP_DB": "/path/to/gsc.db"
      }
    }
  }
}
```

Benefits:
- **Faster** - Local DB queries vs API calls
- **Historical** - Query data older than 16 months
- **Offline** - Works without internet after sync

## Custom MCP Server

Build your own MCP server with gscdump:

```ts
import { createGscDb } from '@gscdump/db'
import { createGscMcpServer } from '@gscdump/mcp/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const db = createGscDb('./gsc.db')

const server = createGscMcpServer({
  name: 'my-gsc-server',
  version: '1.0.0',
  getAuth: () => process.env.GSC_ACCESS_TOKEN,
  getDb: () => db,
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

## Provider Pattern

Use the unified provider for API/DB abstraction:

```ts
import { createProvider } from '@gscdump/query'

const provider = await createProvider({
  auth,
  db,
  source: 'auto', // Checks DB first, falls back to API
  siteUrls: ['sc-domain:example.com'],
  range,
})

// Same interface regardless of data source
const pages = await provider.getPagesWithComparison(siteUrl, range)
```

## Security Notes

- MCP servers run locally - your data stays on your machine
- Access tokens are stored in `~/.config/gscdump/`
- Cloud mode tokens are scoped to GSC read/write only

## Next Steps

- [Historical Database](/docs/guides/historical-database) - Set up DB for faster AI queries
- [SEO Analysis](/docs/guides/seo-analysis) - Analyses you can ask AI to run
