# @gscdump/engine-duckdb-wasm

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-duckdb-wasm?color=yellow)](https://npmjs.com/package/@gscdump/engine-duckdb-wasm)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-duckdb-wasm?color=yellow)](https://npm.chart.dev/@gscdump/engine-duckdb-wasm)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> DuckDB-WASM engine adapter for `@gscdump/analysis` — typed browser analytics against parquet via R2.

In-browser DuckDB-WASM connection wrapped as a `SqlQuerySource`. Ships a vendored, stripped-down drizzle-orm DuckDB-WASM adapter (~240 LoC, adapted from `@proj-airi/drizzle-duckdb-wasm`, MIT). Transactions throw — analytics workload is read-only.

Bundle: **10.3 kB / 2.72 kB gzipped**. `@duckdb/duckdb-wasm` is an optional peer dep.

## Install

```bash
npm install @gscdump/engine-duckdb-wasm @duckdb/duckdb-wasm
```

## Usage

```ts
import {
  attachParquetUrlTables,
  bootDuckDBWasm,
  createInsightRunner,
  resolveWindow,
  scopeFor,
  strikingMomentum,
} from '@gscdump/engine-duckdb-wasm'

const { db, conn } = await bootDuckDBWasm()
await attachParquetUrlTables(conn, { tables: [{ name: 'gsc_keywords', url: '/r2/keywords.parquet' }] })

const runner = createInsightRunner({ db, conn })
const window = resolveWindow({ preset: 'last-30d', comparison: 'prev-period' })
const scope = scopeFor('keywords', { siteId, window })

const rows = await strikingMomentum(runner, { ...scope, limit: 50 })
```

### Engine source for analyzer dispatch

```ts
import { createEngine } from '@gscdump/engine-duckdb-wasm'

const source = createEngine({
  runner: { query: (sql, params) => conn.query(sql, params) },
})
```

## Exports

- `createEngine({ runner })` — builds a `SqlQuerySource` over a DuckDB-WASM connection.
- `createInsightRunner({ db, conn })` — drizzle-orm handle for typed `.select()` / window functions, with `sql\`...\`` raw escape hatch.
- `bootDuckDBWasm()` / `attachParquetTables()` / `attachParquetUrlTables()` / `attachSingleTable()` / `createBrowserAnalysisRuntime()` / `createDuckDBBundlesFromBase()` / `listAttachedTables()` — browser runtime primitives.
- `strikingMomentum(runner, options)` — first-class browser insight.
- `scopeFor(table, { siteId, window })` / `mergeScope()` — tenant scope predicates.
- `pages` / `keywords` / `page_keywords` / `countries` / `devices` / `schema` — drizzle schema mirroring `gscdump/analytics` `SCHEMAS`. Drift fails loudly at module load.
- `browserResolverAdapter` — dialect adapter for the resolver kit.
- `createClient` / `drizzle` / `DuckDBWasmDatabase` — vendored drizzle-orm DuckDB-WASM adapter.
- `resolveWindow` (re-exported from `@gscdump/engine/period`).

## Related

- [`@gscdump/engine`](../engine) — Storage contracts + dialect-neutral resolver.
- [`@gscdump/analysis`](../analysis) — Analyzer registry + `analyzeContentGap` (browser semantic).
- [`@gscdump/engine-duckdb-node`](../engine-duckdb-node) — Node DuckDB counterpart.
- [`@gscdump/engine-sqlite`](../engine-sqlite) — SQLite / D1 counterpart.
- [`@gscdump/nuxt`](../nuxt) — Nuxt layer that ships this runtime client-side.

## License

[MIT](../../LICENSE)
