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

`@duckdb/node-api` is an optional peer for the Node runtime.
The CLI installs this peer. Browser consumers use `@gscdump/engine-duckdb-wasm`.
The package includes `hyparquet` and `hyparquet-writer` for JavaScript Parquet encoding and decoding.

The `/hyparquet` encoders accept optional `fileMetadata: Record<string, string>`:
use `encodeRowsToParquet(table, rows, { fileMetadata })`, or include it in the
options for `encodeRowsToParquetFlex`. Metadata is stored in the file footer, not as fact
columns, including for empty files. Keys are sorted for deterministic encoding;
omitting metadata or passing an empty object preserves the existing bytes.
A publication coordinator can supply a unique identifier so identical rows from
different publications produce different bytes. It must retain and replay the
exact encoded bytes for retries; this option does not provide publication or
recovery coordination itself.

For a bounded, already ordered source, `/hyparquet` also exports
`encodeParquetRowBatches(batches, options, write)`. It consumes sync or async
batches, coerces the declared `columns` with the same physical types as the
array encoder, and emits one Parquet file through an awaited byte callback.
It does not sort, deduplicate, retry, or publish an object. The callback borrows
its bytes until its promise settles; copy a chunk if retaining it. The caller
must abort/discard the entire destination on any error, including an error
while writing the footer. Reopening the same immutable source with identical
options produces identical bytes regardless of producer batch boundaries.
This supports a counting/digest pass followed by a separately coordinated
fixed-length upload, without the codec owning transport or commit semantics.

`decodeParquetRowGroups({ byteLength, slice }, options)` reads exact byte ranges
and by default yields one physical row group at a time. The caller must pin every range
to the same immutable object or ETag. It preserves the existing date, column
projection, row-window and filter behavior. An absent, corrupt, oversized or
incompletely read file throws; only valid empty Parquet yields no rows.

The range reader alone accepts an optional `indexedRowWindow` policy:

```ts
decodeParquetRowGroups(pinnedObject, {
  indexedRowWindow: {
    targetRows: 1000,
    requiredIndexedColumns: ['query', 'url'],
    rangeCacheBytes: 2 * 1024 * 1024,
  },
})
```

Each group uses windows only when all designated columns are present, selected,
have usable offset-index descriptors, and have no dictionary encoding. The
schema must contain only flat scalar/UTF8/date fields; binary, nested and other
unsupported schemas retain the original group read. Ineligible groups use the
original uncached path, so `targetRows` is a target rather than a hard batch
limit. Include every potentially large column in `requiredIndexedColumns`.
All existing physical-group admission limits still apply.

Before emitting an eligible group's first window, the reader checks index
structure for projected columns, or all indexed columns when a filter may need
unprojected fields: row zero, increasing row positions, ordered nonoverlapping
page ranges and physical column bounds. A failure throws without falling back
after partial output. This assumes metadata row offsets agree with physical
page contents; it does not independently verify page-header row counts or
detect every deliberately consistent but false index.

The optional range cache defaults to zero, allows at most 2 MiB of payload and
128 entries, and lives only through one eligible group. It is cleared on
completion, error or iterator return; another pass rereads the pinned object.
It does not cache decoded rows or provide publication/ETag coordination. Windows
can otherwise reread overlapping pages and substantially increase range I/O.
They still decode whole boundary pages, and dictionaries in other columns can
still allocate in full. These options do not bound decompressed page sizes or
the total heap; the unchanged fallback also retains its existing memory costs.
Buffered decoders, encoders and all omitted-option behavior remain unchanged.

The range reader can also opt into `limits.maxReadAndDecompressBytes`. This is a
**cumulative buffer-work budget for each physical group**, shared across all its
indexed windows and concurrent column reads. It charges requested source-range
bytes before dispatch and SNAPPY output bytes before allocating the fixed-size
output buffer. Cache hits do not allocate another range, while repeated
decompression still consumes budget. Group indexes are included; the initial
footer has its separate metadata limit. Raw/uncompressed pages and V2 levels
are covered by the range charge, so compressed data is deliberately counted
twice. Earlier charges are never refunded, including after a failed read. Failure
or iterator return closes the budget, preventing new work and rejecting late
range results. It cannot physically cancel already dispatched reads: the range
source interface has no cancellation hook.

ZSTD decompression refuses under this option: the current allocating decoder
can allocate from its frame header before checking the Parquet output size.
Without the option, ZSTD and all existing decoding behavior remain unchanged.
The budget does not measure JavaScript strings, expanded values, row containers,
internal prefetch or dictionary/page stitching copies, codec working state or
caller-retained batches. It is
not a total heap bound or protection against all malformed Parquet contents.
It can reject valid files that previously decoded, particularly old files whose
writer understated uncompressed footer sizes. Callers must preserve those files
and choose their own explicit retry/repair policy; refusal is never empty data.

`decodeParquetRowGroups(source, { boundedValues: {} })` selects a separate strict
value-cursor path. It supports flat REQUIRED/OPTIONAL scalar columns, explicitly
annotated UTF8/STRING, PLAIN and dictionary data pages (V1/V2), and SNAPPY or
UNCOMPRESSED data. Projection, physical row ranges, nulls, date normalization and
row order are preserved. Nested/binary/other logical types, other codecs or value
encodings, BOOLEAN dictionaries, filters and `indexedRowWindow` combinations
refuse; this mode never silently falls back to the eager reader. All selected
page headers are inspected before the first output to detect unsupported later
pages. Corrupt value bodies or over-limit individual values may fail after an
earlier batch; consumers must finish validating their entire input before
publishing a replacement.
Explicit row bounds in this strict mode must be nonnegative safe integers, with
positive Infinity also accepted for an open-ended `rowEnd`. Omitted bounds use
the full input, and reversed or zero-length ranges are empty.

The cursor retains at most one current data page and one encoded dictionary per
selected column. UTF8 strings, definition levels and dictionary IDs are consumed
incrementally. Dictionaries retain encoded bytes and a four-byte offset per
entry, rather than an array of decoded strings. Final bit-packed padding is
validated but not expanded. These options have independent meanings:

| `boundedValues` option | Default | Admission rule |
| --- | --- | --- |
| `targetRows` | 1000 | Hard emitted batch row limit |
| `maxBatchBytes` | 1 MiB | Before materialization: 128 per row, 16 per cell slot, 64 per cell plus twice UTF8 byte length or 32 for a fixed scalar |
| `maxValueBytes` | 256 KiB | Encoded bytes of one string, before decoding |
| `maxActiveBytes` | 24 MiB | Per group: sum of each column's largest compressed + uncompressed data page, dictionary compressed + uncompressed bytes, dictionary offset tables, plus one maximum header probe |
| `maxPages` | 16384 | Retained page-descriptor count across the selected input |
| `maxHeaderBytes` | 64 KiB | Header probe cap; starts at 512 bytes and grows only on truncation |
| `maxDictionaryEntries` | 100000 | Entry count for each encoded dictionary |

Active-buffer admission uses real page headers, not the often understated
uncompressed sizes in legacy writer footers. Page transitions release the old
cursor before reading/decompressing its successor; columns load sequentially.
Batch bytes are a conservative value-materialization charge, **not a measurement
of V8 object overhead or an isolate heap guarantee**. The footer (separately
bounded), page-descriptor objects, fixed cursor/schema state, caller-retained
batches, codec/runtime overhead and concurrent application work remain separate.
Setting larger limits deliberately permits a larger working set. A single page
still decompresses in full, and a consumer that retains all emitted batches
removes the benefit. This mode does not make arbitrary malicious files safe.

The existing `maxReadAndDecompressBytes` option also applies: a group's header
probes, physical reads and SNAPPY output share one cumulative budget. Headers
are scanned once; immutable/pinned object bytes are required across that scan
and later reads. Iterator return/error releases cursor references; already
dispatched source reads cannot be physically aborted. Defaults, the buffered
decoder and indexed-window eligibility/fallback are unchanged.

Both APIs have configurable admission limits. The encoder bounds producer
batch rows/value bytes, output group rows/value bytes, retained descriptor counts
and scalar bytes (including statistics), and the current encoded group/footer
buffer. The decoder checks footer size,
descriptor count, declared group rows/uncompressed bytes, and every range request.
The default decoder accepts the existing encoder's 25,000-row groups. These
limits do not establish a Worker heap guarantee: caller-retained rows, codec
transient allocations, footer descriptors, and concurrent requests still use
memory. Metadata limits are not protection against malicious Parquet contents.
The existing array APIs and their default bytes are unchanged.

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
