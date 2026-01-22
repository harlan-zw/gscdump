# @gscdump/db

[![npm version](https://img.shields.io/npm/v/@gscdump/db?color=yellow)](https://npmjs.com/package/@gscdump/db)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/db?color=yellow)](https://npm.chart.dev/@gscdump/db)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> SQLite persistence for Google Search Console data with Drizzle ORM.

## Features

- **SQLite Storage** - Own your data locally, no cloud lock-in
- **Drizzle ORM** - Type-safe queries with full schema access
- **Sync Functions** - Incremental updates for sites, pages, and keywords
- **Precision Storage** - Float metrics stored as integers for accuracy

## Install

```bash
npm install @gscdump/db
```

## Usage

```ts
import { createGscDb, setup, syncSites, syncTables } from '@gscdump/db'
import sqliteConnector from 'db0/connectors/better-sqlite3'

const { db, db0 } = createGscDb(sqliteConnector({ name: 'gsc.db' }))

// Create tables
await setup(db0)

// Sync sites
await syncSites(db, client)

// Sync analytics for a site
await syncTables(db, client, siteId, siteUrl, ['pages', 'keywords', 'countries'])
```

### Querying with Drizzle

Access the schema for custom queries:

```ts
import { createGscDb } from '@gscdump/db'
import * as schema from '@gscdump/db/schema'
import { desc, eq } from 'drizzle-orm'

// Get top pages by clicks
const topPages = await db
  .select()
  .from(schema.sitePathDateAnalytics)
  .where(eq(schema.sitePathDateAnalytics.siteId, 1))
  .orderBy(desc(schema.sitePathDateAnalytics.clicks))
  .limit(10)
```

## Exports

```ts
// Main exports
import { createGscDb, setup, syncSites, syncTables, ... } from '@gscdump/db'

// Schema (tables and types)
import { sites, sitePathDateAnalytics, ... } from '@gscdump/db/schema'
import type { SiteInsert, SiteSelect } from '@gscdump/db/schema'
```

## Metric Storage

Float values are stored as integers for precision:

| Metric | Storage | Example |
|--------|---------|---------|
| `ctr` | `ctr * 10000` | 0.0523 → 523 |
| `position` | `position * 100` | 4.7 → 470 |

The library handles conversion automatically when reading/writing.

## Schema

The database includes tables for:
- `sites` - GSC properties
- `sitePathDateAnalytics` - Page-level metrics by date
- `siteKeywordDateAnalytics` - Keyword-level metrics by date
- `siteKeywordPathDateAnalytics` - Keyword+page combinations by date
- `siteDateCountryAnalytics` - Country breakdown by date
- `siteDateDeviceAnalytics` - Device breakdown by date
- `sitePathIndexing` - URL indexing status

## Related Packages

- [`gscdump`](../gscdump) - Core library
- [`@gscdump/cli`](../cli) - CLI with `sync` command
- [`@gscdump/query`](../query) - Unified data provider

## License

[MIT](../../LICENSE)
