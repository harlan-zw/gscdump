# Package architecture

`gscdump` ships five independent subsystems under one package, each exported as its own subpath so consumers only pay for what they import.

| Subsystem | Entry | What it does |
|---|---|---|
| Core client | `gscdump` | GSC REST wrapper (search analytics, sites, sitemaps, inspection, indexing) |
| Query builder | `gscdump/query` | Typed DSL that compiles to GSC request bodies or analytics SQL |
| Analysis | `gscdump/analysis` | Pure SEO analyzers (striking-distance, opportunity, movers, etc.) + fetch wrappers |
| Driver | `gscdump/driver` | Uniform `GscDriver` facade with local and cloud implementations |
| Analytics | `gscdump/analytics` | Append-only Parquet-on-object-store engine (+ Node adapters under `/node`, `/filesystem`) |

## `src/core/`, `src/api/`

GSC REST client. `googleSearchConsole(auth)` returns a client with async generators for `searchAnalytics.query`, `sites`, `urlInspection`, `sitemaps`, `indexing`. Edge-compatible, `fetch`/`ofetch`-based, no `node:` imports. This is the live-API path.

## `src/query/`

Typed query-builder over the GSC API. `gsc.select(page, query).where(between(date, ...)).limit(1000)` produces a `BuilderState` that either resolves to a live REST body (`resolveToBody`) or feeds the analytics SQL resolver. The state object is lossless, so the same builder drives both the live GSC call and offline Parquet queries.

## `src/analysis/`

Pure analyzer functions that operate on already-fetched `QueryResult` rows: `analyzeStrikingDistance`, `analyzeOpportunity`, `analyzeMovers`, `analyzeDecay`, `analyzeBrandSegmentation`, `analyzeClustering`, `analyzeConcentration`, `analyzeSeasonality`. Each analyzer is side-effect-free, runtime-agnostic, and typed end-to-end.

`fetch.ts` pairs each analyzer with a `fetch*` wrapper (`fetchStrikingDistance`, `fetchOpportunity`, ...) that calls the core client for the right dimensions/date range, then hands rows to the analyzer. `queryAnalytics` and `queryComparison` are the underlying single- and two-period fetchers.

## `src/driver/`

Thin abstraction that lets callers target either a local GSC client or a hosted gscdump.com API behind one interface.

- `GscDriver` (`mode: 'local' | 'cloud'`) exposes `sites`, `query`, `sitemaps`, `submitSitemap`, `deleteSitemap`, `inspect`, `analysis`.
- `CloudGscDriver` extends it with multi-site registration, sync status/trigger, indexing diagnostics, sitemap health, and arbitrary `data`/`detail` passthroughs.
- `createLocalDriver({ auth })` wires the REST client + `fetch*` analyzers into the driver shape.
- `createCloudDriver({ apiBase, token })` delegates everything to the hosted API over `fetch`.
- `isCloudDriver(driver)` narrows to `CloudGscDriver` for cloud-only calls.

CLI commands consume the driver rather than the core client so the same command implementation works against both modes.

## `src/analytics/` — Ring 2 storage engine

Append-only Parquet-on-object-store layer with pluggable `DataSource` + `ManifestStore` + `ParquetCodec` + `QueryExecutor`. The engine is runtime-agnostic; the CLI runs it against `FilesystemDataSource` + `FilesystemManifestStore`, and gscdump.com runs the same engine against an R2 `DataSource` + D1 `ManifestStore`. Core architectural decisions (why R2/Parquet, atomicity contract, query-resolver port strategy) live in the canonical plan doc: [gscdump.com/docs/plans/2026-04-12-r2-duckdb-migration.md](https://github.com/harlan-zw/gscdump.com/blob/main/docs/plans/2026-04-12-r2-duckdb-migration.md).

### Public interfaces (exported from `gscdump/analytics`)

- `DataSource`, bytes-level storage (`read`, `write`, `delete`, `list`). Ships with `InMemoryDataSource` (tests) and `FilesystemDataSource` (Node subpath).
- `ManifestStore`, truth for which objects are live (`listLive`, `listAll`, `registerVersion`, `registerVersions`, `listRetired`, `delete`). Ships with in-memory and filesystem (atomic JSON-on-disk) implementations.
- `ParquetCodec`, pluggable encode/decode used by writes + compaction. `createDuckDBCodec` wraps DuckDB-WASM `COPY TO`; `createJsonCodec` lets the engine's state-machine tests run without booting DuckDB.
- `QueryExecutor`, runs resolved SQL against a set of file buffers. `createDuckDBExecutor` for prod, `createUnionExecutor` for tests.
- `StorageEngine`, `writeDay`, `query`, `compactDay`, `compactMonth`, `gcOrphans`. Enforces the atomicity contract below.
- `analyzeWithDuckDB(deps, ctx, params)`, SQL-native analyzer dispatcher. All filtering, scoring, and ranking happens in SQL using DuckDB-specific features (`regexp_extract`, `list_slice`, `STDDEV_POP`, struct literals, `to_json`); shape functions only re-pack rows into the driver's `AnalysisResult` envelope. Unsupported analyses throw `AnalyzerUnsupportedError` so callers can fall back to the row-based analyzers in `src/analysis/`.
- `normalizeUrl(input)`, write-time URL normalizer that collapses GSC full URLs to pathname+search so read-side filters work uniformly across URL-prefix and domain properties.

### Atomicity contract (see `test/analytics/engine.test.ts`)

1. `writeDay` is atomic from a reader's perspective: the new version is either fully live or not.
2. Object keys are content-addressable (`…__v{epochMs}.parquet`, optionally `__shard-N` for overflow). Old versions coexist with new until GC.
3. `registerVersion` / `registerVersions` flag superseded entries `retiredAt = now`; retired rows persist in the manifest until `gcOrphans` removes them.
4. Compaction (day and month) writes the merged file first, flips the manifest atomically, never deletes inputs before the swap.
5. Shard overflow triggers at `shardBytes` (default 50 MB); shards share one partition with distinct object keys, registered together so readers never see a partial swap.
6. `gcOrphans(graceMs)` deletes only retired entries older than grace.
7. Schema is append-only; read SQL uses `union_by_name = true` so newer files with extra columns stay back-compatible.

### Layout

```
src/analytics/
  storage.ts                # Interfaces + key helpers (edge-safe)
  schema.ts                 # Parquet table schemas, inferTable, dimension→column
  normalize.ts              # Write-time URL normalization (pathname+search)
  engine.ts                 # createStorageEngine — orchestrates writeDay/query/compaction/gc
  resolver.ts               # BuilderState → { sql, params, partitions }
  compaction.ts             # compactDay / compactMonth / enumeratePartitions
  gc.ts                     # gcOrphans implementation
  duckdb.ts                 # Edge-safe DuckDBHandle interface + codec/executor factories
  duckdb-analyze.ts         # Edge-safe SQL-native analyzers (striking-distance, opportunity, brand, clustering, concentration, seasonality, movers, decay)
  adapters/
    in-memory.ts            # InMemoryDataSource / InMemoryManifestStore / JSON codec / UnionExecutor
    filesystem.ts           # Node-only: FilesystemDataSource / FilesystemManifestStore (atomic JSON)
    duckdb-node.ts          # Node-only: DuckDBHandle via blocking WASM bindings
```

Edge compatibility rule: core files (storage, schema, normalize, engine, resolver, compaction, gc, duckdb, duckdb-analyze, in-memory) must not import `node:*`. Only `adapters/filesystem.ts` and `adapters/duckdb-node.ts` may. Tree-shaking keeps the Worker bundle clean.

### Package exports

- `gscdump` — core REST client + types
- `gscdump/query` — builder, columns, operators, resolver, date helpers
- `gscdump/analysis` — pure analyzers + `fetch*` wrappers
- `gscdump/driver` — `GscDriver`, `CloudGscDriver`, `createLocalDriver`, `createCloudDriver`, `isCloudDriver`
- `gscdump/analytics` — engine, interfaces, in-memory adapters, DuckDB codec/executor/analyzer (edge-safe)
- `gscdump/analytics/node` — `createNodeDuckDBHandle`, `resetNodeDuckDB` (Node-only)
- `gscdump/analytics/filesystem` — `createFilesystemDataSource`, `createFilesystemManifestStore`, `filesystemStats` (Node-only)

Node-only adapters ship under their own subpath exports so a Workers bundle importing `gscdump/analytics` doesn't drag in `node:fs` or the blocking DuckDB bindings.
