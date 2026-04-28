# @gscdump/engine

[![npm version](https://img.shields.io/npm/v/@gscdump/engine?color=yellow)](https://npmjs.com/package/@gscdump/engine)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine?color=yellow)](https://npm.chart.dev/@gscdump/engine)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Append-only Parquet/DuckDB storage engine + planner + adapters for the gscdump pipeline. Node + edge runtimes; opt-in heavy peers.

Owns the storage runtime, planner, schema, and adapters that were previously bundled into `gscdump`. Edge consumers stay on [`gscdump`](../gscdump); anything that needs to read/write Parquet, run the DuckDB executor, or attach a snapshot lives here.

## Install

```bash
npm install @gscdump/engine
```

Optional peers (install only what your runtime needs):

- `@duckdb/duckdb-wasm` — DuckDB-WASM executor (browser + node-blocking shim).
- `hyparquet`, `hyparquet-writer` — pure-JS Parquet codec for environments without a native build.

## Subpath exports

| Subpath | Purpose |
|---|---|
| `@gscdump/engine` | Barrel: `createStorageEngine`, codec/executor factories, all storage contracts. |
| `@gscdump/engine/contracts` | `StorageEngine`, `Row`, `TableName`, `WriteCtx`, `ManifestEntry`, ... |
| `@gscdump/engine/schema` | `SCHEMAS`, `allTables`, `inferTable`, column metadata. |
| `@gscdump/engine/planner` | `resolveToSQL`, `enumeratePartitions`, partition planning. |
| `@gscdump/engine/snapshot` | `SnapshotIndex` contract for hot/cold snapshot files. |
| `@gscdump/engine/ingest` | GSC row → storage row helpers (`createRowAccumulator`, `transformGscRow`). |
| `@gscdump/engine/sql` | SQL literal binding helpers (`bindLiterals`, `formatLiteral`). |
| `@gscdump/engine/sql-fragments` | Reusable SQL fragments shared across analyzers. |
| `@gscdump/engine/rollups` | Pre-aggregated rollup contracts + helpers. |
| `@gscdump/engine/entities` | Entity helpers (sites, tenants, scope keys). |
| `@gscdump/engine/resolver` | Dialect-neutral SQL composition: `ResolverAdapter`, `pgResolverAdapter`, `compilePg`/`compileSqlite`, `resolveToSQL`. |
| `@gscdump/engine/scope` | Multi-tenant scope predicates. |
| `@gscdump/engine/arrow` | Apache Arrow utilities for engine result conversion. |
| `@gscdump/engine/node` | Node-only DuckDB handle. |
| `@gscdump/engine/node-harness` | Node test harness for engine integration tests. |
| `@gscdump/engine/filesystem` | Node-only `DataSource` + `ManifestStore` adapters. |
| `@gscdump/engine/http` | Read-only HTTP `DataSource` (signed URLs, Range requests). |
| `@gscdump/engine/hyparquet` | Pure-JS `ParquetCodec`. |
| `@gscdump/engine/r2` | Cloudflare R2 `DataSource` (structurally typed against `R2Bucket`). |
| `@gscdump/engine/r2-manifest` | R2-backed `ManifestStore` for hosted deployments. |
| `@gscdump/engine/inspection-sqlite-node` | Node SQLite adapter for URL-inspection cache. |
| `@gscdump/engine/inspection-sqlite-browser` | Browser (wa-sqlite) adapter for URL-inspection cache. |

## Stability

| Surface | Stability |
|---|---|
| `createStorageEngine` and storage contracts (`StorageEngine`, `Row`, `WriteCtx`, ...) | Public |
| Adapters (`/node`, `/filesystem`, `/http`, `/hyparquet`, `/r2`) | Public |
| Planner (`resolveToSQL`, `enumeratePartitions`) | Public |
| Schema (`SCHEMAS`, `allTables`, ...) | Public |
| Internals reached through `@gscdump/engine/<file>` paths not listed above | Private — may break between minors |

## Related

- [`gscdump`](../gscdump) — REST client + query builder (edge-safe peer dep).
- [`@gscdump/analysis`](../analysis) — analyzers; consumes `StorageEngine` via `createEngine` factories.
- [`@gscdump/engine-duckdb-node`](../engine-duckdb-node) — Node DuckDB analyzer adapter.
- [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm) — DuckDB-WASM browser adapter.
- [`@gscdump/engine-sqlite`](../engine-sqlite) — SQLite / D1 adapter.
- [`@gscdump/cli`](../cli) — CLI wrapping engine + analysis.

## License

[MIT](../../LICENSE)
