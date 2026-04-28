# @gscdump/engine-duckdb-node

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-duckdb-node?color=yellow)](https://npmjs.com/package/@gscdump/engine-duckdb-node)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-duckdb-node?color=yellow)](https://npm.chart.dev/@gscdump/engine-duckdb-node)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Node DuckDB engine adapter — wraps the parquet storage engine as a `SqlQuerySource` and ships parquet/snapshot attach helpers for the browser-style attached-table path.

## Install

```bash
npm install @gscdump/engine-duckdb-node @gscdump/engine
```

## Usage

```ts
import { ROW_ANALYZERS, SQL_ANALYZERS } from '@gscdump/analysis'
import { createEngine } from '@gscdump/engine-duckdb-node'
import { createAnalyzerRegistry, runAnalyzerFromSource } from '@gscdump/engine/analyzer'

const source = createEngine({ engine, ctx })
const registry = createAnalyzerRegistry({ rows: ROW_ANALYZERS, sql: SQL_ANALYZERS })

const result = await runAnalyzerFromSource(
  source,
  { type: 'striking-distance', minImpressions: 100 },
  registry,
)
```

### Attaching parquet for the browser-style path

```ts
import { analyzeInBrowser } from '@gscdump/analysis'
import { attachParquetIndex, attachSnapshotIndex } from '@gscdump/engine-duckdb-node'

await attachParquetIndex(conn, { files }) // per-day or per-month parquet
await attachSnapshotIndex(conn, { snapshot }) // pre-baked .duckdb snapshot

const result = await analyzeInBrowser(
  { query: (sql, params) => conn.runAndReadAll(sql, params).then(r => r.getRowObjects()) },
  { schema: 'gsc' },
  { type: 'striking-distance' },
)
```

## Exports

- `createEngine({ engine, ctx })` — builds a `SqlQuerySource` from a `StorageEngine` + `TenantCtx` (delegates to `createEngineQuerySource` from `@gscdump/engine/source`).
- `attachParquetIndex` / `attachSnapshotIndex` / `snapshotAlias` — DuckDB session attach helpers.

`SQL_ANALYZERS`, `analyzeInBrowser`, and `rewriteForTableSource` moved to `@gscdump/analysis` (they reference the analyzer instances and don't belong on the engine boundary).

## Related

- [`@gscdump/engine`](../engine) — Storage engine + analyzer/source contracts.
- [`@gscdump/analysis`](../analysis) — Analyzer instances + `analyzeInBrowser` + `SQL_ANALYZERS`.
- [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm) — Browser counterpart (DuckDB-WASM).
- [`@gscdump/engine-sqlite`](../engine-sqlite) — SQLite / D1 counterpart.

## License

[MIT](../../LICENSE)
