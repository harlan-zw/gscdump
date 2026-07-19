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
await attachParquetUrlTables(conn, { tables: [{ name: 'queries', url: '/r2/queries.parquet' }] })

const runner = createInsightRunner({ db, conn })
const window = resolveWindow({ preset: 'last-30d', comparison: 'prev-period' })
const scope = scopeFor('queries', { siteId, window })

const rows = await strikingMomentum(runner, { ...scope, limit: 50 })
```

## Browser Parquet Attachment Strategy

`attachParquetUrlTables()` uses URL registration with DuckDB-WASM's HTTP file
reader rather than downloading parquet objects into JS memory. Each exact-object
URL is preflighted with `HEAD`; if the endpoint does not support `HEAD`, the
runtime performs a one-byte `Range: bytes=0-0` probe. Attachment fails closed
unless the response proves `Content-Length` / `Content-Range` and byte-range
support.

The runtime keeps local guards independent of the server response:
`maxFiles`, `maxBytes`, `fetchConcurrency`, and `AbortSignal` are enforced
before registering files. `bootDuckDBWasm()` opens DuckDB with full HTTP reads
disabled, so a server that cannot satisfy range reads routes to server-side
fallback instead of causing broad browser object downloads.

OPFS (`attachOpfsParquetTables` et al., in `src/opfs.ts`) is the primary
write-through parquet cache: attached snapshot files persist keyed by
manifest `contentHash`/object key, gated by the same file/byte budgets before
anything is materialized locally.

### Attaching parquet as analyzer sources

Per [ADR-0001](../../docs/adr/0001-browser-engine-uses-attached-tables.md), the
browser engine dispatches over attached parquet tables (`createAttachedTableSource`
from `@gscdump/engine/source`, wired up inside `createBrowserAnalysisRuntime`),
not a canonical-schema `SqlQuerySource`. An earlier `createEngine()` wrapping the
canonical-schema path had zero callers and was deleted in 2026-05 — don't
reintroduce it; extend `createAttachedTableSource` or the attach helpers below
instead.

## Exports

- `createInsightRunner({ db, conn })` — drizzle-orm handle for typed `.select()` / window functions, with `sql\`...\`` raw escape hatch.
- `bootDuckDBWasm()` / `attachParquetTables()` / `attachParquetUrlTables()` / `attachSingleTable()` / `createBrowserAnalysisRuntime()` / `createDuckDBBundlesFromBase()` / `listAttachedTables()` — browser runtime primitives.
- `attachOpfsParquetTables()` / `readOpfsSnapshotFile()` / `estimateOpfsStorage()` / `requestPersistentStorage()` / `clearOpfsSnapshotCache()` — OPFS-backed parquet cache.
- `strikingMomentum(runner, options)` — first-class browser insight.
- `scopeFor(table, { siteId, window })` / `mergeScope()` — tenant scope predicates.
- `pages` / `queries` / `page_queries` / `countries` / `dates` / `hourly_pages` / `schema` — drizzle schema mirroring `gscdump/analytics` `SCHEMAS`. Drift fails loudly at module load.
- `compileArchetypeSql()` / `tableForArchetype()` — archetype query compilation.
- `createClient` / `drizzle` / `DuckDBWasmDatabase` — vendored drizzle-orm DuckDB-WASM adapter.
- `resolveWindow` (re-exported from `@gscdump/engine/period`).

## Related

- [`@gscdump/engine`](../engine) — Storage contracts + dialect-neutral resolver.
- [`@gscdump/analysis`](../analysis) — Analyzer registry + `analyzeContentGap` (browser semantic).
- [`@gscdump/engine-sqlite`](../engine-sqlite) — SQLite / D1 counterpart.

## License

[MIT](../../LICENSE)
