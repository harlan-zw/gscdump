# @gscdump/query

[![npm version](https://img.shields.io/npm/v/@gscdump/query?color=yellow)](https://npmjs.com/package/@gscdump/query)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/query?color=yellow)](https://npm.chart.dev/@gscdump/query)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Unified data provider for Google Search Console - routes queries to API or SQLite database.

## Features

- **Unified Interface** - Same API whether data comes from GSC API or local database
- **Automatic Routing** - Queries route to DB when data exists, falls back to API
- **Type-Safe** - Full TypeScript types across both providers
- **Transparent** - Consumers don't need to know the data source

## Install

```bash
npm install @gscdump/query
```

## Usage

```ts
import { createDb } from '@gscdump/db'
import { createQueryProvider } from '@gscdump/query'

// Create provider with both sources
const provider = createQueryProvider({
  auth: 'ya29.xxx...',
  db: createDb('./gsc.db'),
})

// Queries automatically route to DB or API
const pages = await provider.pages('https://example.com', {
  startDate: '2024-01-01',
  endDate: '2024-01-31',
})

const keywords = await provider.keywords('https://example.com', {
  startDate: '2024-01-01',
  endDate: '2024-01-31',
})
```

### API-Only Provider

```ts
import { createQueryProvider } from '@gscdump/query'

// No database - all queries go to GSC API
const provider = createQueryProvider({
  auth: 'ya29.xxx...',
})

const pages = await provider.pages('https://example.com', {
  startDate: '2024-01-01',
  endDate: '2024-01-31',
})
```

### DB-Only Provider

```ts
import { createDb } from '@gscdump/db'
import { createQueryProvider } from '@gscdump/query'

// No API auth - queries only work if data exists in DB
const provider = createQueryProvider({
  db: createDb('./gsc.db'),
})
```

## API

### `createQueryProvider(options)`

Creates a data provider that routes queries to the appropriate source.

**Options:**
- `auth` - GSC API auth token or credentials
- `db` - Database instance from `@gscdump/db`

**Methods:**
- `sites()` - List all sites
- `pages(site, options)` - Query page metrics
- `keywords(site, options)` - Query keyword metrics
- `devices(site, options)` - Query device breakdown
- `countries(site, options)` - Query country breakdown
- `comparison(site, options)` - Period-over-period comparison

## Related Packages

- [`gscdump`](../gscdump) - Core library
- [`@gscdump/db`](../db) - SQLite persistence
- [`@gscdump/cli`](../cli) - CLI
- [`@gscdump/mcp`](../mcp) - MCP server

## License

[MIT](../../LICENSE)
