# Package architecture

`gscdump` is the core library. Analyzers, cloud SDK, and MCP server live in sibling packages in this monorepo. See [`/ROADMAP.md`](../../ROADMAP.md) for current status and next actions.

## Monorepo layout

```
packages/
  gscdump/          # Core — REST client + query builder + Parquet/DuckDB engine
  analysis/         # @gscdump/analysis — row-based + SQL-native analyzers
  cli/              # @gscdump/cli — CLI entry (gscdump)
  cloud/            # @gscdump/cloud — cloud SDK + cloud CLI (frozen)
  mcp/              # @gscdump/mcp — MCP server (frozen)
```

Dependency graph:

- `@gscdump/cli` → `gscdump`, `@gscdump/analysis`, `@gscdump/mcp`
- `@gscdump/analysis` → `gscdump`
- `@gscdump/cloud` → `gscdump` (frozen)
- `@gscdump/mcp` → `gscdump` (frozen)

`@gscdump/cloud` and `@gscdump/mcp` are `private: true` and frozen; builds + tests pass, no new features.

## `gscdump` (core) subsystems

| Subsystem | Entry | What it does |
|---|---|---|
| Core client | `gscdump` | GSC REST wrapper (search analytics, sites, sitemaps, inspection, indexing) |
| Query builder | `gscdump/query` | Typed DSL that compiles to GSC request bodies or analytics SQL |
| Driver types | `gscdump/driver` | `GscDriver` interface. Re-exports shared types from `gscdump/shared`. |
| Shared types | `gscdump/shared` | Compatibility barrel for cross-package types. Prefer `gscdump/shared/analysis`, `/driver`, `/snapshot` in sibling packages. |
| Analytics | `gscdump/analytics` | Append-only Parquet-on-object-store engine (+ Node adapters under `/node`, `/filesystem`) |

### `src/core/`, `src/api/`

GSC REST client. `googleSearchConsole(auth)` returns a client with async generators for `searchAnalytics.query`, `sites`, `urlInspection`, `sitemaps`, `indexing`. Edge-compatible, `fetch`/`ofetch`-based, no `node:` imports. This is the live-API path.

### `src/query/`

Typed query-builder over the GSC API. `gsc.select(page, query).where(between(date, ...)).limit(1000)` produces a `BuilderState` that either resolves to a live REST body (`resolveToBody`) or feeds the analytics SQL resolver. The state object is lossless, so the same builder drives both the live GSC call and offline Parquet queries.

### `src/driver/`

Type-only module, kept as the cross-package shared surface for `GscDriver`, `AnalysisParams`, `AnalysisResult`, `DriverSite`, `DriverQueryParams`, `DriverQueryResult`, `DriverSitemap`, `DriverInspectResult`. The CLI instantiates `googleSearchConsole(auth)` + the storage engine directly — no runtime `GscDriver` implementation lives here. `@gscdump/cloud` supplies `CloudGscDriver` + `createCloudDriver` + `isCloudDriver` when the cloud path is live.

### `src/analytics/` — Ring 2 storage engine

Append-only Parquet-on-object-store layer with pluggable `DataSource` + `ManifestStore` + `ParquetCodec` + `QueryExecutor`. The engine is runtime-agnostic; the CLI runs it against `FilesystemDataSource` + `FilesystemManifestStore`, and gscdump.com runs the same engine against an R2 `DataSource` + D1 `ManifestStore`. Core architectural decisions (why R2/Parquet, atomicity contract, query-resolver port strategy) live in the canonical plan doc: [gscdump.com/docs/plans/2026-04-12-r2-duckdb-migration.md](https://github.com/harlan-zw/gscdump.com/blob/main/docs/plans/2026-04-12-r2-duckdb-migration.md).

#### Public interfaces (exported from `gscdump/analytics`)

- `DataSource`, bytes-level storage (`read`, `write`, `delete`, `list`, optional `head` / `streamList`). Ships with filesystem, HTTP (read-only), and R2 adapters. Test helpers keep an in-memory implementation.
- `ManifestStore`, truth for which objects are live + sync state + locks. `listLive` / `listAll` / `registerVersion` / `registerVersions` / `listRetired` / `delete` / `getWatermarks` / `bumpWatermark` / `getSyncStates` / `setSyncState` / `withLock`. Ships with filesystem (atomic JSON-on-disk).
- `ParquetCodec`, pluggable encode/decode used by writes + compaction. `createDuckDBCodec` wraps DuckDB `COPY TO`; `createHyparquetCodec` (pure-JS, `gscdump/analytics/hyparquet`) avoids DuckDB on the write path.
- `QueryExecutor`, runs resolved SQL against a set of file buffers. `createDuckDBExecutor` for prod.
- `StorageEngine`: engine-owned behavior — `writeDay`, `query`, `runSQL`, `compactOlderThan`, `gcOrphans` — plus pass-through surface — `listLive`, `listAll`, `getWatermarks`, `getSyncStates`, `setSyncState`, `readObject`. Enforces the atomicity contract below. `writeDay` takes `withLock` across write + register so GC can't delete mid-flight bytes. `gcOrphans` re-checks under the same lock before deleting. `runSQL({ ctx, fileSets, sql, params })` is the single raw-SQL entry point used by `@gscdump/analysis/duckdb` — composes `manifestStore.listLive` + `dataSource.read` + `substituteNamedFiles` + `executor.execute` so consumers never reach the underlying ports directly.
- `createRowAccumulator({ maxRows?, normalizeQuery? })` / `transformGscRow(table, apiRow)` — GSC API row → storage `Row` + `{ table → date → Row[] }` bucketing. Per-table key indexing; `normalizeQuery` hook keeps SEO-opinionated canonicalization consumer-side.
- `bindLiterals(sql, params)` / `formatLiteral(value)` — SQL-standard quote-aware `?` parameter inliner for HTTP/RPC executors that can't pass parameters separately.
- `normalizeUrl(input)`, write-time URL normalizer that collapses GSC full URLs to pathname+search so read-side filters work uniformly across URL-prefix and domain properties. **The engine's `writeDay` applies this automatically** to any `url` column — callers should not double-normalize.
- `encodeSiteId(siteUrl)`, deterministic GSC-site-URL → filesystem-safe string. Used by the CLI + any caller to build `TenantCtx.siteId` consistently.
- `substituteNamedFiles(sql, sets)`, binds `{{FILES}}` / `{{FILES_PREV}}` / ... placeholders in raw SQL to concrete object-key lists. Used by raw-SQL consumers and by the SQL-native analyzers in `@gscdump/analysis/duckdb`.

SQL-native analyzers (`analyzeWithDuckDB`, `AnalyzerUnsupportedError`) moved to `@gscdump/analysis/duckdb`. Import from there instead of `gscdump/analytics`.

#### Atomicity contract (see `test/analytics/engine.test.ts`)

1. `writeDay` is atomic from a reader's perspective: the new version is either fully live or not. One file per day; payloads larger than 100 MB fail hard rather than splitting into shards.
2. Object keys are content-addressable (`…__v{epochMs}.parquet`). Old versions coexist with new until GC.
3. `registerVersion` / `registerVersions` flag superseded entries `retiredAt = now`; retired rows persist in the manifest until `gcOrphans` removes them.
4. `compactOlderThan(days)` rolls daily partitions older than the cutoff into one `monthly/{YYYY-MM}` file per (site, table, month); writes the merged file first, flips the manifest atomically, never deletes inputs before the swap.
5. `gcOrphans(graceMs)` deletes only retired entries older than grace.
6. Schema is append-only; read SQL uses `union_by_name = true` so newer files with extra columns stay back-compatible.

#### Layout

```
src/analytics/
  storage.ts                # Interfaces + key helpers (edge-safe)
  schema.ts                 # Parquet table schemas, inferTable, dimension→column, schemaVersion
  normalize.ts              # Write-time URL normalization (pathname+search)
  tenant.ts                 # encodeSiteId — GSC siteUrl → filesystem-safe tenant key
  ingest.ts                 # transformGscRow + createRowAccumulator (GSC API → Row)
  sql-bind.ts               # bindLiterals + formatLiteral (SQL-standard `?` inliner)
  engine.ts                 # createStorageEngine — orchestrates writeDay/query/compaction/gc
                            # (invokes normalizeUrl on every `url` column during writeDay;
                            # takes withLock across write + register)
  resolver.ts               # BuilderState → { sql, params, partitions }; substituteNamedFiles
  compaction.ts             # compactOlderThan / enumeratePartitions (codec-delegated merge)
  gc.ts                     # gcOrphans — grace window + re-check under lock
  duckdb.ts                 # Edge-safe DuckDBHandle interface + codec/executor factories
                            # (table column lists derived from SCHEMAS — no duplicate mapping)
  adapters/
    filesystem.ts           # Node-only: FilesystemDataSource / FilesystemManifestStore (atomic JSON)
    duckdb-node.ts          # Node-only: DuckDBHandle via @duckdb/node-api
    http.ts                 # Edge-safe read-only DataSource over signed URLs (Range + HEAD)
    hyparquet.ts            # Pure-JS ParquetCodec (hyparquet-writer + hyparquet); optional readRows override
    r2.ts                   # Cloudflare R2 DataSource (structurally typed; bucket + key guards)
```

Edge compatibility rule: core files (storage, schema, normalize, tenant, ingest, sql-bind, engine, resolver, compaction, gc, duckdb) and the hyparquet / http / r2 adapters must not import `node:*`. Only `adapters/filesystem.ts` and `adapters/duckdb-node.ts` may. Enforced by `eslint.config.mjs` via `no-restricted-imports`. Test helpers (`test/helpers/in-memory.ts`) hold an in-memory `DataSource` / `ManifestStore` / codec for unit tests.

### `gscdump` package exports

- `gscdump` — core REST client + types
- `gscdump/query` — builder, columns, operators, resolver, date helpers
- `gscdump/driver` — `GscDriver` interface (type-only; re-exports from `gscdump/shared`)
- `gscdump/shared` — compatibility barrel for cross-package type primitives (type-only)
- `gscdump/shared/analysis` — analysis contracts: `AnalysisParams`, `AnalysisResult`, `AnalysisTool` (type-only)
- `gscdump/shared/driver` — driver contracts: `DriverSite`, `DriverQueryParams`, `DriverQueryResult`, `DriverSitemap`, `DriverInspectResult`, ... (type-only)
- `gscdump/shared/snapshot` — snapshot metadata contract: `SnapshotIndex` (type-only)
- `gscdump/analytics` — engine, interfaces, DuckDB codec/executor, `normalizeUrl`, `encodeSiteId`, `substituteNamedFiles`, `createRowAccumulator`, `transformGscRow`, `bindLiterals`, `formatLiteral` (edge-safe)
- `gscdump/analytics/contracts` — storage engine contracts only: `StorageEngine`, `Row`, `TableName`, `TenantCtx`, ... (type-only)
- `gscdump/analytics/schema` — table metadata primitives: `SCHEMAS`, `allTables`, `inferTable`, `dimensionToColumn`, `currentSchemaVersion`
- `gscdump/analytics/planner` — partition + SQL planning primitives: `enumeratePartitions`, `FILES_PLACEHOLDER`, `resolveToSQL`, `substituteNamedFiles`
- `gscdump/analytics/tenant` — `encodeSiteId`
- `gscdump/analytics/normalize` — `normalizeUrl`
- `gscdump/analytics/ingest` — `createRowAccumulator`, `transformGscRow`, `toPath`, `toSumPosition`
- `gscdump/analytics/sql` — `bindLiterals`, `formatLiteral`
- `gscdump/analytics/node` — `createNodeDuckDBHandle`, `resetNodeDuckDB` (Node-only)
- `gscdump/analytics/filesystem` — `createFilesystemDataSource`, `createFilesystemManifestStore`, `filesystemStats` (Node-only)
- `gscdump/analytics/http` — read-only HTTP `DataSource` (edge-safe; Range + signed URLs)
- `gscdump/analytics/hyparquet` — `createHyparquetCodec({ readRows? })` — pure-JS codec (edge-safe; 4.5 kB / 971 B gz)
- `gscdump/analytics/r2` — `createR2DataSource({ bucket, bucketName? })` for Cloudflare Workers (edge-safe; 1.92 kB / 574 B gz)

Node-only adapters ship under their own subpath exports so a Workers bundle importing `gscdump/analytics` doesn't drag in `node:fs` or the blocking DuckDB bindings. The `hyparquet`, `http`, and `r2` adapters are fully edge-safe.

Boundary rule: sibling packages should import the narrowest `gscdump/analytics/*` or `gscdump/shared/*` subpath that matches the primitive they need. The broader barrels remain stable for external consumers, but internal code should not treat them as catch-all surfaces.

## Sibling packages

### `@gscdump/analysis`

Row-based analyzers + SQL-native dispatcher + typed query primitives for DuckDB-WASM / D1. Moved out of core in Phase 0. Exports:

- `./` — `analyzeStrikingDistance`, `analyzeOpportunity`, `analyzeMovers`, `analyzeDecay`, `analyzeBrandSegmentation`, `analyzeClustering`, `analyzeConcentration`, `analyzeSeasonality`, fetch wrappers, `padTimeseries`, `AnalysisParams` / `AnalysisResult` / `AnalysisTool`, period + metric types.
- `./duckdb` — `analyzeWithDuckDB(deps, ctx, params)` (21 analyzers wired), `buildAnalyzerSpec`, `attachParquetIndex`, `attachSnapshotIndex`. Throws `AnalyzerUnsupportedError` only for unknown types.
- `./browser` — DuckDB-WASM primitives: `createInsightRunner({ db, conn })`, `resolveWindow`, `scopeFor` / `mergeScope`, drizzle schema (`schema`, `pages`, `keywords`, `page_keywords`, `countries`, `devices`), `strikingMomentum` insight helper, vendored drizzle-orm DuckDB-WASM adapter (~240 LoC, MIT). Bundle: 10.3 kB / 2.72 kB gz.
- `./sqlite` — D1 / sqlite-proxy mirror: `createSqliteInsightRunner({ executor })`, `compileSqlite(sql)`, `aggClicks` / `aggImpressions` / `aggCtr` / `aggPosition`, runtime-builder primitives (`colRef`, `dimColumn`, `metricSql`, `havingPredicates`, ...), drizzle schema (`gsc_pages`, `gsc_keywords`, ...). Re-exports `sql` + `and` / `eq` / `gte` / `lte` so consumers bind to the package's drizzle-orm instance. Bundle: 5.3 kB / 1.4 kB gz.
- `./query` — dialect-neutral composers for runtime `BuilderState`: `resolveToSQL`, `resolveToSQLOptimized`, `buildTotalsSql`, `buildExtrasQueries`, `mergeExtras`, `resolveComparisonSQL`. Consumers pass a `ResolverAdapter` from `/sqlite` or `/browser`.
- `./window` — `resolveWindow({ preset, comparison, anchor })`. Presets: `last-7d` / `last-28d` / `last-30d` / `last-90d` / `last-180d` / `last-365d` / `mtd` / `ytd` / `custom`. Comparison: `none` / `prev-period` / `yoy`.

Peers: `gscdump`, `@duckdb/duckdb-wasm` (optional, for `/browser` + `/duckdb`).

### `@gscdump/cloud` (frozen)

Cloud SDK + cloud CLI. Owns `CloudGscDriver` interface, all `Cloud*` types, `createCloudDriver`, `isCloudDriver`. Ships `gscdump-cloud` bin with `register`, `unregister`, `sync`, `sitemaps`, `indexing` subcommands. Loads session from `GSCDUMP_CLOUD_SESSION` env or `~/.config/gscdump/cloud-tokens.json`.

Dep: `gscdump`.

### `@gscdump/mcp` (frozen)

MCP server. Ships `gscdump-mcp` bin (env-var auth only). The `@gscdump/cli` `mcp` command wraps the same server with interactive auth/config loading.

Dep: `gscdump`.

### `@gscdump/cli`

CLI entry (`gscdump` bin). Owns config, auth, local engine wiring. Top-level verbs: `init`, `sync`, `query`, `dump`, `sites`, `sitemaps`, `inspect`, `analyze`, `auth`, `config`, `mcp`; plus `store {stats, compact, gc, export}` for local-store admin. `analyze` dispatches 21 tools via `@gscdump/analysis/duckdb`. No cloud-mode branching; cloud-scoped commands live in `@gscdump/cloud` behind the `gscdump-cloud` bin.
