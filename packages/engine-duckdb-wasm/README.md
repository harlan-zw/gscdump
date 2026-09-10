# @gscdump/engine-duckdb-wasm

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-duckdb-wasm?color=yellow)](https://npmjs.com/package/@gscdump/engine-duckdb-wasm)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-duckdb-wasm?color=yellow)](https://npm.chart.dev/@gscdump/engine-duckdb-wasm)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Run DuckDB queries and Analyzers over Parquet files in the browser.

## Install

```bash
npm install @gscdump/engine-duckdb-wasm @duckdb/duckdb-wasm
```

## Query Parquet URLs

```ts
import {
  attachParquetUrlTables,
  bootDuckDBWasm,
  createInsightRunner,
} from '@gscdump/engine-duckdb-wasm'

const { db, conn } = await bootDuckDBWasm()
await attachParquetUrlTables({
  db,
  conn,
  tables: [{ table: 'queries', urls: ['https://example.com/data/queries.parquet'] }],
  maxFiles: 10,
  maxBytes: 50_000_000,
})

const runner = await createInsightRunner({ db, conn })
const client = await runner.client
const rows = await client.query('SELECT query, clicks, impressions FROM queries LIMIT 50')
console.log(rows)
await runner.close()
await db.terminate()
```

Replace the URL with a Parquet file containing the expected table columns, including `date`.
The endpoint must support browser access and byte-range reads.

## Attachment and caching

`attachParquetUrlTables` registers URLs with DuckDB's HTTP reader.
It supports `maxFiles`, `maxBytes`, `fetchConcurrency`, and `signal` limits.

Preflight uses `HEAD`, with a one-byte range probe when needed.
Trusted URL size hints can skip preflight by default; set `trustSizeHint: false` to require endpoint checks.
The default HTTP mode disables full-file fallback reads.
Handle attachment failures in your application if you want to offer server queries instead.

`fetchInit` applies to preflight requests only.
DuckDB's own range reads need URLs that work without custom request headers.

Use `attachOpfsParquetTables` to cache snapshot files in the browser's Origin Private File System.
Its file and byte limits apply before download.
Use `estimateOpfsStorage`, `requestPersistentStorage`, and `clearOpfsSnapshotCache` to manage that cache.

## Analyzers

`createBrowserAnalysisRuntime` runs Analyzers against attached tables.
See [`@gscdump/analysis`](../analysis/README.md#duckdb-and-browser-use) and
[ADR-0001](../../docs/adr/0001-browser-engine-uses-attached-tables.md) for the Source contract.

The package includes a vendored Drizzle adapter for typed queries.
Transactions are unsupported.

## Exports

| Group | Exports |
| --- | --- |
| Runtime | `bootDuckDBWasm`, `createInsightRunner`, `createBrowserAnalysisRuntime` |
| Attachment | `attachParquetTables`, `attachParquetUrlTables`, `attachParquetUrlTablesResult` |
| OPFS | `attachOpfsParquetTables`, `readOpfsSnapshotFile`, storage and cache helpers |
| Schema | `pages`, `queries`, `page_queries`, `countries`, `dates`, `hourly_pages`, `schema` |
| Queries | `compileArchetypeSql`, `tableForArchetype`, `scopeFor`, `mergeScope` |
| Drizzle | `createClient`, `drizzle`, `DuckDBWasmDatabase` |
| Dates | `resolveWindow`, re-exported from `@gscdump/engine/period` |

Schema exports follow `@gscdump/engine/schema`.
Parquet snapshots are Site-specific; browser `scopeFor` currently adds no `siteId` predicate.
Keep authorization and file selection in your application.

## License

[MIT](../../LICENSE)
