## @gscdump/engine

Append-only Parquet/DuckDB storage engine for the gscdump pipeline. Owns the storage runtime, planner, schema, and adapters that were previously bundled into `gscdump`.

Edge consumers stay on [`gscdump`](../gscdump). Anything that needs to read/write Parquet, run the DuckDB executor, or attach a snapshot lives here.

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
| `@gscdump/engine/node` | Node-only DuckDB handle. |
| `@gscdump/engine/filesystem` | Node-only `DataSource` + `ManifestStore` adapters. |
| `@gscdump/engine/http` | Read-only HTTP `DataSource` (signed URLs, Range requests). |
| `@gscdump/engine/hyparquet` | Pure-JS `ParquetCodec`. |
| `@gscdump/engine/r2` | Cloudflare R2 `DataSource` (structurally typed against `R2Bucket`). |

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
- [`@gscdump/cli`](../cli) — CLI wrapping engine + analysis.

## License

[MIT](../../LICENSE)
