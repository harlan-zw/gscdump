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
import { createDb, syncKeywords, syncPages, syncSites } from '@gscdump/db'

const db = createDb('./gsc.db')

// Sync site data
await syncSites(db, auth)

// Sync page metrics for a site
await syncPages(db, auth, 'https://example.com', {
  startDate: '2024-01-01',
  endDate: '2024-01-31',
})

// Sync keyword data
await syncKeywords(db, auth, 'https://example.com', {
  startDate: '2024-01-01',
  endDate: '2024-01-31',
})
```

### Querying with Drizzle

Access the Drizzle instance for custom queries:

```ts
import { createDb, schema } from '@gscdump/db'
import { desc, eq } from 'drizzle-orm'

const db = createDb('./gsc.db')

// Get top pages by clicks
const topPages = await db.drizzle
  .select()
  .from(schema.pages)
  .where(eq(schema.pages.siteUrl, 'https://example.com'))
  .orderBy(desc(schema.pages.clicks))
  .limit(10)
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
- `pages` - Page-level metrics
- `keywords` - Keyword-level metrics
- `keyword_pages` - Keyword-page combinations

## Related Packages

- [`gscdump`](../gscdump) - Core library
- [`@gscdump/cli`](../cli) - CLI with `sync` command
- [`@gscdump/query`](../query) - Unified data provider

## License

[MIT](../../LICENSE)
