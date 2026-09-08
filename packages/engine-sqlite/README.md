# @gscdump/engine-sqlite

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-sqlite?color=yellow)](https://npmjs.com/package/@gscdump/engine-sqlite)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-sqlite?color=yellow)](https://npm.chart.dev/@gscdump/engine-sqlite)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Run typed analytics over SQLite or D1 through an async executor.

`createSqliteQuerySource` wraps an executor as an `AnalysisQuerySource` scoped to a Site.
The Engine resolver builds the SQL; your executor runs it.

## Install

```bash
npm install @gscdump/engine-sqlite @gscdump/engine drizzle-orm
```

## Usage

```ts
import {
  aggCtr,
  compileSqlite,
  gsc_keywords,
  sql,
} from '@gscdump/engine-sqlite'

const queryExpr = sql`
  SELECT ${gsc_keywords.query} as query,
         SUM(${gsc_keywords.clicks}) as clicks,
         ${aggCtr(gsc_keywords)} as ctr
  FROM ${gsc_keywords}
  WHERE ${gsc_keywords.site_id} = ${siteId}
  GROUP BY ${gsc_keywords.query}
`

const { sql: compiledSql, params } = compileSqlite(queryExpr)
const { rows } = await executor(compiledSql, params, 'all')
```

### Engine source for analyzer dispatch

```ts
import { createSqliteQuerySource } from '@gscdump/engine-sqlite'

const source = createSqliteQuerySource({
  executor, // (sql, params, mode) => { rows }
  siteId,
  regex: true, // Enable only if your executor supports REGEXP
})
```

Import `sql` from `@gscdump/engine-sqlite` so it uses the same Drizzle instance as the package.
This avoids `SQL<unknown>` type mismatches between installations.

## Exports

- `createSqliteQuerySource({ executor, siteId, regex? })` : builds an `AnalysisQuerySource`.
- `createSqliteInsightRunner({ executor })` : sqlite-proxy drizzle adapter.
- `compileSqlite(sql)` : compile to `{ sql, params }` for any HTTP executor.
- `aggClicks` / `aggImpressions` / `aggCtr` / `aggPosition` : aggregate helpers.
- `scopeFor(table, { siteId, window })` / `mergeScope()` : tenant scope predicates.
- `gsc_pages` / `gsc_keywords` / `gsc_page_keywords` / `gsc_countries` / `gsc_devices` / `gsc_query_dim` / `schema` : drizzle schema mirroring `@gscdump/engine/schema`.
- `sqliteResolverAdapter` / `createSqliteResolverAdapter` / `probeSqliteRegex` : dialect adapter for the resolver kit.
- `resolveWindow` (re-exported from `@gscdump/engine/period`).

## Storage tables

The `gsc_*` tables remain exported for SQLite and D1 consumers.
This adapter also exports `createD1ManifestStore` and its `r2*` manifest tables.
Your application owns table creation, migrations, and data ingestion.
The CLI uses a Parquet Store; it does not sync into these SQLite tables.

## Related

- [`@gscdump/engine`](../engine) : Storage contracts + dialect-neutral resolver.
- [`@gscdump/analysis`](../analysis) : Analyzer registry + dispatcher.
- [`@gscdump/engine/node`](../engine) : Node DuckDB counterpart.
- [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm) : Browser DuckDB-WASM counterpart.

## License

[MIT](../../LICENSE)
