# @gscdump/query

[![npm version](https://img.shields.io/npm/v/@gscdump/query?color=yellow)](https://npmjs.com/package/@gscdump/query)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/query?color=yellow)](https://npm.chart.dev/@gscdump/query)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Unified data provider for Google Search Console - routes queries to API or SQLite database with automatic sync.

## Features

- **Unified Interface** - Same API whether data comes from GSC API or local database
- **Automatic Sync** - When using hybrid mode, automatically fetches and persists data on cache miss
- **Type-Safe** - Full TypeScript types across both providers
- **Simple API** - Just provide `auth`, `db`, or both

## Install

```bash
npm install @gscdump/query
```

## Usage

### API Only

Fetch directly from Google Search Console API:

```ts
import { createProvider } from '@gscdump/query'

const provider = createProvider({ auth: oauthClient })

const pages = await provider.getPagesWithComparison('https://example.com', range)
```

### DB Only

Read from local SQLite database (errors if data is missing):

```ts
import { createGscDb } from '@gscdump/db'
import { createProvider } from '@gscdump/query'

const { db } = createGscDb(connector)
const provider = createProvider({ db })

const pages = await provider.getPagesWithComparison('https://example.com', range)
```

### Hybrid (Recommended)

Uses DB as cache, automatically syncs from API when data is missing:

```ts
import { createGscDb } from '@gscdump/db'
import { createProvider } from '@gscdump/query'

const { db } = createGscDb(connector)
const provider = createProvider({ auth: oauthClient, db })

// First call: fetches from API, syncs to DB, returns result
// Second call: returns from DB (fast!)
const pages = await provider.getPagesWithComparison('https://example.com', range)
```

## API

### `createProvider(options)`

Creates a data provider based on what's provided:

| Options | Behavior |
|---------|----------|
| `{ auth }` | API only - fetches directly from GSC |
| `{ db }` | DB only - reads from local database (errors if missing) |
| `{ auth, db }` | Hybrid - uses DB as cache, syncs from API on miss |

**Methods:**

- `getDatesWithComparison(site, range)` - Daily metrics with comparison
- `getPages(site, range)` - All pages for period
- `getPagesWithComparison(site, range)` - Pages with period comparison
- `getKeywordsWithComparison(site, range)` - Keywords with comparison
- `getCountriesWithComparison(site, range)` - Country breakdown
- `getDevicesWithComparison(site, range)` - Device breakdown
- `getPage(site, range, path)` - Single page details
- `getKeyword(site, range, keyword)` - Single keyword details

### Direct Providers

For more control, use the provider factories directly:

```ts
import { createApiProvider, createDbProvider, createHybridProvider } from '@gscdump/query'

const api = createApiProvider(auth)
const db = createDbProvider(db)
const hybrid = createHybridProvider(auth, db)
```

## Related Packages

- [`gscdump`](../gscdump) - Core library
- [`@gscdump/db`](../db) - SQLite persistence
- [`@gscdump/cli`](../cli) - CLI
- [`@gscdump/mcp`](../mcp) - MCP server

## License

[MIT](../../LICENSE)
