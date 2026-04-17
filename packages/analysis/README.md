# @gscdump/analysis

[![npm version](https://img.shields.io/npm/v/@gscdump/analysis?color=yellow)](https://npmjs.com/package/@gscdump/analysis)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/analysis?color=yellow)](https://npm.chart.dev/@gscdump/analysis)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> SEO analyzers + typed query primitives for Google Search Console data. Row-based, DuckDB-native, D1-ready.

## Install

```bash
npm install @gscdump/analysis
```

## When to use which subpath

| Subpath | Use when |
|---|---|
| `@gscdump/analysis` | You have arrays of rows (GSC API responses, D1 query results). Pure functions, no DB. |
| `@gscdump/analysis/duckdb` | You have a DuckDB handle (Node or WASM) over parquet. Analyzer runs as SQL. |
| `@gscdump/analysis/browser` | Nuxt / React / vanilla app running DuckDB-WASM client-side against R2 parquets. |
| `@gscdump/analysis/sqlite` | Cloudflare Workers / anywhere routing through sqlite-proxy (D1). |
| `@gscdump/analysis/query` | Dialect-neutral composers for runtime `BuilderState` → SQL. |
| `@gscdump/analysis/window` | Canonical date windows (`last-30d`, `mtd`, `ytd`, `prev-period`, `yoy`). No DB. |

## Row-based analyzers

Pure functions. Take typed arrays in, return typed results out.

```ts
import {
  analyzeBrandSegmentation,
  analyzeClustering,
  analyzeConcentration,
  analyzeDecay,
  analyzeMovers,
  analyzeOpportunity,
  analyzeSeasonality,
  analyzeStrikingDistance,
  padTimeseries,
} from '@gscdump/analysis'

const striking = analyzeStrikingDistance(keywordRows, { minImpressions: 100 })
const movers = analyzeMovers(currentRows, previousRows)
const decay = analyzeDecay(currentRows, previousRows)
```

Fetch wrappers compose a GSC client + analyzer in one call:

```ts
import { fetchMovers, fetchStrikingDistance } from '@gscdump/analysis'

const movers = await fetchMovers(auth, siteUrl, { period, previous })
```

## DuckDB (Node + WASM)

SQL-native path. Same analyzers, but compiled against DuckDB over parquet.

```ts
import { analyzeWithDuckDB, buildAnalyzerSpec } from '@gscdump/analysis/duckdb'

const spec = buildAnalyzerSpec({ type: 'striking-distance', minImpressions: 100 })
const result = await analyzeWithDuckDB({ engine }, ctx, spec)
```

`attachParquetIndex` and `attachSnapshotIndex` wire parquet files (per-day, per-month, or pre-baked `.duckdb` snapshots) into a DuckDB session before the analyzer runs.

## Browser (DuckDB-WASM)

Three primitives for client-side analytics:

```ts
import {
  createInsightRunner,
  resolveWindow,
  scopeFor,
  strikingMomentum,
} from '@gscdump/analysis/browser'

const runner = createInsightRunner({ db, conn }) // AsyncDuckDB + connection
const window = resolveWindow({ preset: 'last-30d', comparison: 'prev-period' })
const scope = scopeFor('pages', { siteId, window })

const rows = await strikingMomentum(runner, { ...scope, limit: 50 })
```

- `createInsightRunner({ db, conn })` — drizzle-orm handle over DuckDB-WASM. Typed `.select()` / window functions, or drop to `sql\`...\`` raw.
- `resolveWindow({ preset, comparison, anchor })` — canonical date windows, no DB.
- `scopeFor(table, { siteId, window })` + `mergeScope()` — boundary predicates for multi-tenant queries.
- `schema`, `pages`, `keywords`, `page_keywords`, `countries`, `devices` — drizzle schema mirroring `gscdump/analytics` `SCHEMAS`. Drift fails loudly at load.

Vendors a stripped-down drizzle-orm DuckDB-WASM adapter (~240 LoC, adapted from `@proj-airi/drizzle-duckdb-wasm`, MIT). Transactions throw — analytics workload is read-only.

`@duckdb/duckdb-wasm` is an optional peer dep. Bundle: **10.3 kB / 2.72 kB gzipped**.

## SQLite (D1 / Cloudflare Workers)

Mirror of `/browser`, dialect-targeted at sqlite-core.

```ts
import {
  aggClicks,
  aggCtr,
  aggImpressions,
  aggPosition,
  compileSqlite,
  createSqliteInsightRunner,
  gsc_keywords,
  sql,
} from '@gscdump/analysis/sqlite'

const queryExpr = sql`
  SELECT ${gsc_keywords.query} as keyword,
         SUM(${gsc_keywords.clicks}) as clicks,
         ${aggCtr(gsc_keywords)} as ctr
  FROM ${gsc_keywords}
  WHERE ${gsc_keywords.site_id} = ${siteId}
  GROUP BY ${gsc_keywords.query}
`
const { sql: compiledSql, params } = compileSqlite(queryExpr)
const rows = await executor(compiledSql, params) // queryUserD1, etc.
```

- `createSqliteInsightRunner({ executor })` — sqlite-proxy drizzle adapter.
- `compileSqlite(sql)` — compile to `{ sql, params }` for any HTTP executor.
- `aggClicks` / `aggImpressions` / `aggCtr` / `aggPosition` — aggregate helpers replacing hand-rolled `METRICS_SQL`.
- Runtime builder exports (`colRef`, `dimColumn`, `metricSql`, `havingPredicates`, …) for dimension/metric driven query builders.

Always import `sql` from `@gscdump/analysis/sqlite` — not `drizzle-orm` directly — so consumers bind to the package's drizzle-orm instance and avoid cross-install `SQL<unknown>` mismatches.

Bundle: **5.3 kB / 1.4 kB gzipped**.

## Query composers (dialect-neutral)

```ts
import {
  buildTotalsSql,
  resolveToSQL,
  resolveToSQLOptimized,
} from '@gscdump/analysis/query'
import { sqliteResolverAdapter } from '@gscdump/analysis/sqlite'

const resolved = resolveToSQL(sqliteResolverAdapter, builderState)
```

Pass a `ResolverAdapter` from `/sqlite` (D1, `site_id`-scoped) or `/browser` (parquet, single tenant). Composers stay identical; only the column bindings + dialect compilation differ.

## Window resolution

```ts
import { resolveWindow } from '@gscdump/analysis/window'

const w = resolveWindow({ preset: 'last-30d', comparison: 'yoy' })
// { start: '...', end: '...', days: 30, comparison: { start, end } }
```

Presets: `last-7d`, `last-28d`, `last-30d`, `last-90d`, `last-180d`, `last-365d`, `mtd`, `ytd`, `custom`. Comparison modes: `none`, `prev-period`, `yoy`.

## Related

- [`gscdump`](../gscdump) — GSC API client + query builder + analytics pipeline.
- [`@gscdump/cli`](../cli) — CLI wrapping `gscdump` + `@gscdump/analysis`.

## License

[MIT](../../LICENSE)
