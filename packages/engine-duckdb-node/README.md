# @gscdump/engine-duckdb-node

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-duckdb-node?color=yellow)](https://npmjs.com/package/@gscdump/engine-duckdb-node)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-duckdb-node?color=yellow)](https://npm.chart.dev/@gscdump/engine-duckdb-node)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Node DuckDB engine adapter for `@gscdump/analysis` — SQL analyzer dispatch over parquet via duckdb-node.

Wraps the append-only Parquet storage engine as a `SqlQuerySource`. SQL-native analyzers dispatch uniformly via `runAnalyzerFromSource`; row-based analyzers stay in `@gscdump/analysis`.

## Install

```bash
npm install @gscdump/engine-duckdb-node @gscdump/engine @gscdump/analysis
```

## Usage

```ts
import { createAnalyzerRegistry, ROW_ANALYZERS, runAnalyzerFromSource } from '@gscdump/analysis/analyzer'
import { createEngine, SQL_ANALYZERS } from '@gscdump/engine-duckdb-node'

const source = createEngine({ engine, ctx })
const registry = createAnalyzerRegistry({ rows: ROW_ANALYZERS, sql: SQL_ANALYZERS })

const result = await runAnalyzerFromSource(
  source,
  { type: 'striking-distance', minImpressions: 100 },
  registry,
)
```

### Attaching parquet for browser-style queries

```ts
import { analyzeInBrowser, attachParquetIndex, attachSnapshotIndex } from '@gscdump/engine-duckdb-node'

await attachParquetIndex(conn, { files }) // per-day or per-month parquet
await attachSnapshotIndex(conn, { snapshot }) // pre-baked .duckdb snapshot

const result = await analyzeInBrowser(conn, { type: 'striking-distance' })
```

## Exports

- `createEngine({ engine, ctx })` — builds a `SqlQuerySource` from a `StorageEngine` + `TenantCtx`.
- `SQL_ANALYZERS` — registry of SQL-native analyzer specs.
- `analyzeInBrowser` / `rewriteForTableSource` — attached-table dispatch path.
- `attachParquetIndex` / `attachSnapshotIndex` / `snapshotAlias` — DuckDB session attach helpers.

## Related

- [`@gscdump/engine`](../engine) — Storage engine + contracts this adapter binds to.
- [`@gscdump/analysis`](../analysis) — Analyzer registry + dispatcher.
- [`@gscdump/engine-wasm`](../engine-wasm) — Browser counterpart (DuckDB-WASM).
- [`@gscdump/engine-sqlite`](../engine-sqlite) — SQLite / D1 counterpart.

## License

[MIT](../../LICENSE)
