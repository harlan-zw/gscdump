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
| `@gscdump/analysis/analyzer` | Analyzer contracts (`Analyzer`, `Plan`, `FileSet`), `ROW_ANALYZERS`, registry, dispatcher. |
| `@gscdump/engine-duckdb-node` | You have a Node DuckDB handle over parquet. Ships `SQL_ANALYZERS` + `analyzeInBrowser` for attached-table parquet. |
| `@gscdump/engine-wasm` | Nuxt / React / vanilla app running DuckDB-WASM client-side against R2 parquets. |
| `@gscdump/engine-sqlite` | Cloudflare Workers / anywhere routing through sqlite-proxy (D1). |
| `@gscdump/engine/resolver` | Dialect-neutral SQL composition kit: `ResolverAdapter`, `pgResolverAdapter`, `compilePg`/`compileSqlite`, `resolveToSQL`, source contracts. |
| `@gscdump/analysis/source` | Portable query sources + source-backed analyzers shared across GSC API, sqlite, DuckDB, and tests. |
| `@gscdump/analysis/semantic` | Browser-only semantic analyzers such as content-gap; optional `@huggingface/transformers` peer. |
| `@gscdump/analysis/query` | `buildDataQueryPlan` / `buildDataDetailPlan` for the generic query analyzers. |

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

Meta-analysis helpers are available too:

```ts
import { analyzeActionPriority } from '@gscdump/analysis'

const prioritized = await analyzeActionPriority({
  analyze: params => runner.analyze(params),
})
```

Source adapters compose a GSC client + analyzer in one call:

```ts
import {
  analyzeMoversFromSource,
  analyzeStrikingDistanceFromSource,
  createGscApiQuerySource,
} from '@gscdump/analysis'

const source = createGscApiQuerySource({ client, siteUrl })
const movers = await analyzeMoversFromSource(source, { current, previous })
```

## DuckDB (Node)

SQL-native path. `SQL_ANALYZERS` dispatch through `runAnalyzerFromSource` against an engine-backed source.

```ts
import { createAnalyzerRegistry, ROW_ANALYZERS, runAnalyzerFromSource } from '@gscdump/analysis/analyzer'
import { createEngine, SQL_ANALYZERS } from '@gscdump/engine-duckdb-node'

const source = createEngine({ engine, ctx })
const registry = createAnalyzerRegistry({ rows: ROW_ANALYZERS, sql: SQL_ANALYZERS })
const result = await runAnalyzerFromSource(source, { type: 'striking-distance', minImpressions: 100 }, registry)
```

`attachParquetIndex` and `attachSnapshotIndex` wire parquet files (per-day, per-month, or pre-baked `.duckdb` snapshots) into a DuckDB session for `analyzeInBrowser` (attached-table path).

## Browser (DuckDB-WASM)

Three primitives for client-side analytics:

```ts
import {
  createInsightRunner,
  resolveWindow,
  scopeFor,
  strikingMomentum,
} from '@gscdump/engine-wasm'

const runner = createInsightRunner({ db, conn }) // AsyncDuckDB + connection
const window = resolveWindow({ preset: 'last-30d', comparison: 'prev-period' })
const scope = scopeFor('pages', { siteId, window })

const rows = await strikingMomentum(runner, { ...scope, limit: 50 })
```

- `createInsightRunner({ db, conn })` — drizzle-orm handle over DuckDB-WASM. Typed `.select()` / window functions, or drop to `sql\`...\`` raw.
- `bootDuckDBWasm()` / `attachParquetUrlTables()` / `attachParquetTables()` / `createBrowserAnalysisRuntime()` — reusable browser runtime primitives for booting DuckDB-WASM, attaching parquet-backed views, and exposing `query()` / `analyze()` helpers without rewriting the same glue in every app.
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
} from '@gscdump/engine-sqlite'

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

Always import `sql` from `@gscdump/engine-sqlite` — not `drizzle-orm` directly — so consumers bind to the package's drizzle-orm instance and avoid cross-install `SQL<unknown>` mismatches.

Bundle: **5.3 kB / 1.4 kB gzipped**.

## Query composers (dialect-neutral)

```ts
import { sqliteResolverAdapter } from '@gscdump/engine-sqlite'
import {
  buildTotalsSql,
  pgResolverAdapter,
  resolveToSQL,
  resolveToSQLOptimized,
} from '@gscdump/engine/resolver'

const resolved = resolveToSQL(builderState, { adapter: sqliteResolverAdapter, siteId })
```

Pass `sqliteResolverAdapter` from `@gscdump/engine-sqlite` (D1, `site_id`-scoped) or `pgResolverAdapter` from `@gscdump/engine/resolver` (parquet via DuckDB, single tenant). Composers stay identical; only the column bindings + dialect compilation differ.

## Sources (portable)

`/source` is the cross-implementation seam:

```ts
import {
  analyzeMoversFromSource,
  createEngineQuerySource,
  queryRows,
} from '@gscdump/analysis/source'

const source = createEngineQuerySource({
  engine,
  ctx: { userId, siteId },
})

const rows = await queryRows(source, builderState)
const movers = await analyzeMoversFromSource(source, periods)
```

Available source factories:

- `createGscApiQuerySource({ client, siteUrl })`
- `createBrowserQuerySource({ query(sql, params) })`
- `createSqliteQuerySource({ executor, siteId })`
- `createEngineQuerySource({ engine, ctx })`
- `createInMemoryQuerySource({ queryRows })`

Portable analyzers currently cover the row-based tools:
`striking-distance`, `opportunity`, `brand`, `clustering`, `concentration`,
`seasonality`, `movers`, and `decay`.

## Semantic (browser-only)

`/semantic` holds browser-only analysis that depends on client runtime
capabilities rather than SQL backends alone.

```ts
import { analyzeContentGap } from '@gscdump/analysis/semantic'

const result = await analyzeContentGap(runner, {
  maxQueries: 1500,
  minDivergence: 0.12,
})
```

`analyzeContentGap()` loads a MiniLM/BGE embedding model via
`@huggingface/transformers`, caches vectors in IndexedDB, and compares top
queries to candidate URLs derived from `page_keywords`.

## Window resolution

```ts
import { resolveWindow } from '@gscdump/engine-wasm'

const w = resolveWindow({ preset: 'last-30d', comparison: 'yoy' })
// { start: '...', end: '...', days: 30, comparison: { start, end } }
```

Presets: `last-7d`, `last-28d`, `last-30d`, `last-90d`, `last-180d`, `last-365d`, `mtd`, `ytd`, `custom`. Comparison modes: `none`, `prev-period`, `yoy`.

## Stability

| Surface | Stability |
|---|---|
| Row analyzers (`analyzeStrikingDistance`, `analyzeMovers`, ...) | Public |
| Source factories (`create*QuerySource`) + `analyzeFromSource` | Public |
| Engine factories (`@gscdump/analysis/engine/<name>`'s `createEngine`) | Public |
| `Analyzer<P, R>` contract + `analyzerRegistry` | Public |
| `/period`, `/query`, `/source`, `/semantic` subpaths | Public |
| Internals reached through `@gscdump/analysis/engine/<name>/<file>` not listed above | Private |

## Related

- [`gscdump`](../gscdump) — REST client + query builder (edge-safe).
- [`@gscdump/engine`](../engine) — Parquet/DuckDB storage engine.
- [`@gscdump/cli`](../cli) — CLI wrapping `gscdump` + `@gscdump/engine` + `@gscdump/analysis`.

## License

[MIT](../../LICENSE)
