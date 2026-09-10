# @gscdump/engine

[![npm version](https://img.shields.io/npm/v/@gscdump/engine?color=yellow)](https://npmjs.com/package/@gscdump/engine)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine?color=yellow)](https://npm.chart.dev/@gscdump/engine)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Store Search Console data in Parquet files and query it with DuckDB.
This package also provides Source contracts, SQL resolution, and runtime adapters.

Choose an export for your runtime.
Node filesystem and DuckDB helpers live on dedicated subpaths.

## Install

```bash
npm install @gscdump/engine
```

`@duckdb/duckdb-wasm` is an optional peer for the WASM runtime.
The package includes `hyparquet` and `hyparquet-writer` for JavaScript Parquet encoding and decoding.

## Subpath exports

| Subpath | Purpose |
|---|---|
| `@gscdump/engine` | Storage runtime: `createStorageEngine`, codec/executor factories, storage contracts. |
| `@gscdump/engine/contracts` | `StorageEngine`, `Row`, `TableName`, `WriteCtx`, `ManifestEntry`, ... |
| `@gscdump/engine/schema` | `SCHEMAS`, `allTables`, `inferTable`, column metadata. |
| `@gscdump/engine/planner` | `resolveToSQL`, `enumeratePartitions`, partition planning. |
| `@gscdump/engine/ingest` | GSC row → storage row helpers (`createRowAccumulator`, `transformGscRow`). |
| `@gscdump/engine/ingest-accumulator` | Stateful ingest flushing behind injected storage and recovery hooks. |
| `@gscdump/engine/sql` | SQL literal binding helpers (`bindLiterals`, `formatLiteral`). |
| `@gscdump/engine/sql-fragments` | Reusable SQL fragments shared across analyzers. |
| `@gscdump/engine/rollups` | Pre-aggregated rollup contracts and helpers. |
| `@gscdump/engine/entities` | Parquet-backed entity stores and their record contracts. |
| `@gscdump/engine/entity-keys` | Pure entity object-key and URL-hash helpers, with no Parquet runtime. |
| `@gscdump/engine/resolver` | Dialect-neutral SQL composition: `ResolverAdapter`, `pgResolverAdapter`, `resolveToSQL`. |
| `@gscdump/engine/scope` | Multi-tenant scope predicates. |
| `@gscdump/engine/arrow` | Apache Arrow utilities for engine result conversion. |
| `@gscdump/engine/node` | Node-only DuckDB handle. |
| `@gscdump/engine/filesystem` | Node-only `DataSource` and `ManifestStore` adapters. |
| `@gscdump/engine/hyparquet` | Pure-JS `ParquetCodec`. |
| `@gscdump/engine/r2` | Cloudflare R2 `DataSource` and `createR2ManifestStore` (structurally typed against `R2Bucket`). |
| `@gscdump/engine/iceberg` | Edge-safe GSC dataset schemas, catalog wrappers, and append sink. Generic Iceberg APIs live in `@gscdump/lakehouse`. |
| `@gscdump/engine/sink-node` | Node-only Iceberg overwrite/delete recovery writer. |
| `@gscdump/engine/source` | Source contracts and factories. |
| `@gscdump/engine/analyzer` | Analyzer contracts, registry construction, and dispatch. |
| `@gscdump/engine/report` | Report definitions and contracts. |
| `@gscdump/engine/period` | Date windows and comparison ranges. |
| `@gscdump/engine/analysis-types` | Analysis parameters and results. |
| `@gscdump/engine/analysis-range` | Analysis date-range resolution. |
| `@gscdump/engine/errors` | Tagged Engine failures. |
| `@gscdump/engine/profile` | Query timing and profiling helpers. |
| `@gscdump/engine/sync-config` | Sync limits and table/search-type configuration. |
| `@gscdump/engine/vendor/hysnappy` | Worker-compatible compression alias. |

## Stability

| Surface | Stability |
|---|---|
| `createStorageEngine` and storage contracts (`StorageEngine`, `Row`, `WriteCtx`, ...) | Public |
| Adapters (`/node`, `/filesystem`, `/hyparquet`, `/r2`) | Public |
| Planner (`resolveToSQL`, `enumeratePartitions`) | Public |
| Schema (`SCHEMAS`, `allTables`, ...) | Public |
| Files outside the declared package exports | Private |

## Related

- [`gscdump`](../gscdump) : REST client and query builder (edge-safe peer dep).
- [`@gscdump/analysis`](../analysis) : analyzers; consumes storage through `AnalysisQuerySource` adapters.
- [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm) : DuckDB-WASM browser adapter.
- [`@gscdump/engine-sqlite`](../engine-sqlite) : SQLite / D1 adapter.
- [`@gscdump/lakehouse`](../lakehouse) : dataset-agnostic Iceberg catalog and
  dataset registry APIs.
- [`@gscdump/cli`](../cli) : CLI wrapping engine and analysis.

## License

[MIT](../../LICENSE)
