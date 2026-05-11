# Architecture

Pipeline: **GSC API → DuckDB → analysis → CLI**. See [`ROADMAP.md`](./ROADMAP.md) for current status and next actions.

## Monorepo layout

```
gscdump/
├── packages/
│   ├── gscdump/              # Core: REST client, query builder, driver/tenant/normalize primitives (edge-safe)
│   ├── engine/               # @gscdump/engine: Parquet/DuckDB storage engine + canonical drizzle pg-core schema + SQL resolver kit + analyzer/source/period contracts
│   ├── engine-duckdb-wasm/   # @gscdump/engine-duckdb-wasm: DuckDB-WASM engine adapter (browser + R2 parquet)
│   ├── engine-sqlite/        # @gscdump/engine-sqlite: SQLite / D1 engine adapter
│   ├── engine-gsc-api/       # @gscdump/engine-gsc-api: GSC live-API engine adapter
│   ├── analysis/             # @gscdump/analysis: analyzer instances (row + sql) + composite source + browser dispatcher
│   ├── cli/                  # @gscdump/cli: CLI entry (gscdump bin)
│   ├── contracts/            # @gscdump/contracts: hosted API/webhook/realtime schemas and route metadata
│   ├── sdk/                  # @gscdump/sdk: consumer SDK for hosted gscdump.com integrations
│   └── mcp/                  # @gscdump/mcp: MCP server (frozen)
└── pnpm-workspace.yaml
```

Web app lives separately at https://github.com/harlan-zw/gscdump.com.

Dependency graph (acyclic; engine packages no longer depend on `@gscdump/analysis`):

- `@gscdump/cli` → `gscdump`, `@gscdump/engine`, `@gscdump/analysis`, `@gscdump/mcp`
- `@gscdump/analysis` → `gscdump`, `@gscdump/engine`, `@gscdump/engine-gsc-api`
- `@gscdump/engine-duckdb-wasm` → `gscdump`, `@gscdump/engine`, `@gscdump/analysis` (`analyzeInBrowser` for the in-runtime dispatch path)
- `@gscdump/engine-sqlite` → `gscdump`, `@gscdump/engine`
- `@gscdump/engine-gsc-api` → `gscdump`, `@gscdump/engine`
- `@gscdump/engine` → `gscdump`
- `@gscdump/contracts` → `gscdump` (type/schema contracts)
- `@gscdump/sdk` → `@gscdump/contracts`
- `@gscdump/mcp` → `gscdump` (frozen)

Canonical schema source of truth: `@gscdump/engine/schema` exports drizzle pg-core tables (`pages`, `keywords`, `countries`, `devices`, `page_keywords`). Every other representation — the abstract `SCHEMAS: Record<TableName, TableSchema>` for parquet writer / planner, the sqlite-core tables in `@gscdump/engine-sqlite` — is derived from or validated against this.

`@gscdump/mcp` is `private: true` and frozen; builds + tests pass, no new features.

## Packages

### `gscdump` (core)

Edge-safe GSC REST wrapper + typed query builder + cross-package contract primitives. No `node:*`, no `@duckdb/*`, no `hyparquet*` — install on workers, edge runtimes, browsers.

Subpath exports:

| Export | Purpose |
|---|---|
| `gscdump` | `googleSearchConsole(auth)` client + REST helpers |
| `gscdump/query` | Builder, columns, operators, resolver, date helpers, planner types (`BuilderState`, `LogicalQueryPlan`, `PlannerCapabilities`) |
| `gscdump/query/plan` | Logical planner internals (`buildLogicalPlan`, comparison plans) |
| `gscdump/driver` | Driver contracts (`DriverSite`, `DriverQueryResult`, `DriverInspectResult`, `DriverSitemap`, ...) |
| `gscdump/tenant` | Tenant/site key primitive (`encodeSiteId`) |
| `gscdump/normalize` | URL normalization primitive (`normalizeUrl`) |

Optional peers: `@googleapis/indexing`, `@googleapis/searchconsole` (only needed if you call REST helpers).

### `@gscdump/engine`

Append-only Parquet/DuckDB storage engine. Storage runtime, planner, schema, adapters — extracted from `gscdump` so edge consumers don't pay the install cost.

| Export | Purpose |
|---|---|
| `@gscdump/engine` | Barrel: `createStorageEngine`, codec/executor, storage contracts, drizzle schema tables. |
| `@gscdump/engine/contracts` | Storage contracts (`StorageEngine`, `Row`, `TableName`, `WriteCtx`, ...). |
| `@gscdump/engine/snapshot` | Snapshot metadata contract (`SnapshotIndex`). |
| `@gscdump/engine/schema` | Canonical drizzle pg-core tables (`pages`, `keywords`, ...) + derived `SCHEMAS` + `TABLE_METADATA` (sortKey, version). Source of truth. |
| `@gscdump/engine/resolver` | SQL composition kit: `pgResolverAdapter`, `createResolverAdapter`, `resolveToSQL` + comparison composers, `assertSchemaInSync`. (`compileSqlite` lives in `@gscdump/engine-sqlite`; `compilePg` is internal to `pg-adapter`.) |
| `@gscdump/engine/analyzer` | Analyzer contracts (`Analyzer`, `Capability`, `Plan`, `SqlPlan`, `RowQueriesPlan`), `defineAnalyzer` factory, `runAnalyzerFromSource` dispatcher, `createAnalyzerRegistry`. |
| `@gscdump/engine/analysis-types` | Analyzer call contracts (`AnalysisParams`, `AnalysisResult`, `AnalysisTool`) + `num` coercion. |
| `@gscdump/engine/period` | Window primitives: `resolveWindow`, `AnalysisPeriod`, `ComparisonPeriod`, `padTimeseries`, `windowToPeriod`, `windowToComparisonPeriod`. Dialect-agnostic. |
| `@gscdump/engine/source` | Source seam: `AnalysisQuerySource` contract (`SourceCapabilities`, `QueryRow`, `FileSet`, `ExecuteSqlOptions`); generic `createSqlQuerySource` factory; `createEngineQuerySource` (Parquet/DuckDB), `createAttachedTableSource` (browser/attached views); `runAnalyzerWithEngine`, `typedQuery`/`queryRows`/`queryComparisonRows` ergonomics. |
| `@gscdump/engine/planner` | Logical → SQL compiler + partition planning (`resolveToSQL`, `enumeratePartitions`). |
| `@gscdump/engine/ingest` | GSC row → storage row (`createRowAccumulator`, `transformGscRow`). |
| `@gscdump/engine/sql` | SQL literal binding (`bindLiterals`, `formatLiteral`). |
| `@gscdump/engine/sql-fragments` | Reusable SQL fragments for resolver/analyzer composition. |
| `@gscdump/engine/rollups` | Post-sync rollup builders: `RollupDef`, `DEFAULT_ROLLUPS`, `rebuildRollups`, `rollupKey`, `RollupEnvelope` (JSON-backed daily/weekly totals + top-N pages/keywords + indexing metadata). |
| `@gscdump/engine/entities` | Per-site entity stores: `createInspectionStore`, `createSitemapStore`, `createIndexingMetadataStore`, `createEmptyTypesStore` + record types (`InspectionRecord`, `SitemapRecord`, `IndexingMetadataRecord`). JSON-backed, one index per site + monthly history shards. |
| `@gscdump/engine/node` | Node-only entrypoint: DuckDB handle (`createNodeDuckDBHandle`, `resetNodeDuckDB`), one-call wiring (`createNodeHarness`), parquet view attach (`attachParquetIndex`), snapshot index attach (`attachSnapshotIndex`, `snapshotAlias`). |
| `@gscdump/engine/filesystem` | Node-only `DataSource` + `ManifestStore` adapters. |
| `@gscdump/engine/http` | Read-only HTTP `DataSource` (signed URLs, Range). |
| `@gscdump/engine/hyparquet` | Pure-JS `ParquetCodec` (sort-on-write by `TABLE_METADATA[table].sortKey`, multi-row-group output, `columnIndex: true`). |
| `@gscdump/engine/r2` | Cloudflare R2 `DataSource` (structurally typed against `R2Bucket`). |
| `@gscdump/engine/r2-manifest` | R2-native `ManifestStore`: HEAD pointer + immutable snapshots per `(siteId, table)`, CAS via `onlyIf.etagMatches` for concurrent writers. |

Optional peers: `@duckdb/duckdb-wasm`, `hyparquet`, `hyparquet-writer`.

Boundary rule: sibling packages should prefer the narrowest subpath that matches the primitive they need. Analyzer call contracts (`AnalysisParams`, `AnalysisResult`, `AnalysisTool`) live in `@gscdump/engine/analysis-types`; the `Analyzer` interface, dispatcher, registry, and `defineAnalyzer` factory live in `@gscdump/engine/analyzer`; window primitives in `@gscdump/engine/period`; the engine-backed source factory in `@gscdump/engine/source`. `@gscdump/analysis` re-exports the public surface for ergonomics but doesn't own the contracts.

See [`packages/gscdump/ARCHITECTURE.md`](./packages/gscdump/ARCHITECTURE.md) for subsystem detail.

### `@gscdump/analysis`

Analyzer instances (row + SQL), composite source, browser dispatcher, semantic analyzers. Public-API barrel re-exports the contract layer from `@gscdump/engine` for ergonomics.

| Export | Purpose |
|---|---|
| `@gscdump/analysis` | Row analyzers (`analyzeStrikingDistance`, `analyzeOpportunity`, `analyzeMovers`, `analyzeDecay`, `analyzeBrandSegmentation`, `analyzeClustering`, `analyzeConcentration`, `analyzeSeasonality`); `SQL_ANALYZERS` array; `analyzeInBrowser` (attached-table dispatcher); `defaultAnalyzerRegistry`; re-exports from `@gscdump/engine/analyzer`, `/analysis-types`, `/period`, `/source`, `/resolver` for one-import ergonomics. |
| `/analyzer` | `ROW_ANALYZERS` array + `paginate*` / `adapt-rows` helpers used by analyzer authors. |
| `/registry` | Pre-built `defaultAnalyzerRegistry` (rows + sql); transitively pulls in all analyzer SQL strings. |
| `/query` | Query-analyzer plan builders (`buildDataQueryPlan`, `buildDataDetailPlan`) for `data-query` / `data-detail` analyzers. |
| `/source` | Composite + in-memory source factories (`createCompositeSource`, `createInMemoryQuerySource`), source-backed analyzers (`analyzeFromSource`, `analyze*FromSource`), `AttachedTableRunner` source. Re-exports GSC-API factories from `@gscdump/engine-gsc-api`. |
| `/semantic` | Embedding-backed analyzers (e.g. `analyzeContentGap`). Lazy `@huggingface/transformers` peer. |

Deps: `gscdump`, `@gscdump/engine`, `@gscdump/engine-gsc-api`. No engine-adapter deps (cycle broken).

### `@gscdump/engine-duckdb-wasm`

Browser DuckDB-WASM primitives: `createInsightRunner({ db, conn })`, `scopeFor`/`mergeScope`, `strikingMomentum`, `bootDuckDBWasm`, `attachParquetTables`/`attachParquetUrlTables`, `createBrowserAnalysisRuntime`, vendored drizzle-orm DuckDB-WASM adapter. Re-exports canonical drizzle schema from `@gscdump/engine`. The browser analysis path runs through `createAttachedTableSource` (attached parquet views), not a canonical-schema `SqlQuerySource`. Optional peer: `@duckdb/duckdb-wasm`.

### `@gscdump/engine-sqlite`

D1 / sqlite-proxy engine adapter: `createEngine({ executor, siteId }) → SqlQuerySource`, plus `createSqliteInsightRunner({ executor })`, `sqliteResolverAdapter`, `agg*` helpers, drizzle sqlite-core schema (superset of canonical columns; drift-checked).

### `@gscdump/engine-gsc-api`

GSC live-API engine adapter. Wraps the Search Analytics REST API as a `RowQuerySource` so row-based analyzers dispatch through `runAnalyzerFromSource`. Exports `createGscApiQuerySource`, `createLiveGscSource`, `canProxyToGsc` (composite-source guard), `fetchGscTopN` / `fetchGscDaily` / `collectGscRows` rollup helpers, `applyBuilderStatePostProcessing`, `GSC_API_CAPABILITIES`. Used by `createCompositeSource` for date-out-of-range fallback and by gscdump.com / CLI for free-tier flows.

### `@gscdump/cli`

CLI entry, `gscdump` bin. Owns config, auth, local engine wiring.

| Command | Role |
|---|---|
| `init` | Set up Google OAuth credentials |
| `sync` | GSC API → DuckDB ingestion |
| `query` | Read from DuckDB (`--live` hits GSC directly) |
| `dump` | Export DuckDB rows to stdout/file |
| `sites` | List GSC properties (live) |
| `sitemaps` | Manage sitemaps (live) |
| `inspect` | URL inspection (live) |
| `analyze` | Run analyzers from `@gscdump/analysis` against DuckDB (`--live` for row-based against fresh API) |
| `entities inspect` / `entities show` / `entities sitemaps {snapshot,show}` / `entities indexing snapshot` | Snapshot slow-changing GSC state (URL inspection, sitemap state, indexing metadata) into the per-site entity store |
| `store stats` / `store compact` / `store gc` / `store export` / `store rollups rebuild` | Local store admin |
| `auth` | Manage credentials |
| `config` | Manage CLI config |
| `mcp` | Wraps `@gscdump/mcp` with CLI-side auth/config |

**Read-path default:** `query`, `dump`, `analyze` read from DuckDB. If the request's date range isn't covered by the sync watermark, fail with an actionable `run gscdump sync first`. `--live` opts into the live GSC API. `sites`, `sitemaps`, `inspect` are always live; they don't store. `sync --types web,discover,news,googleNews,image,video` fans out across searchType partitions (non-`web` types get a `<table>/<searchType>/` path segment). `entities *` commands persist slow-changing state to the per-site entity store.

### `@gscdump/contracts`

Shared gscdump.com API, webhook, realtime, and lifecycle contracts. Owns route
metadata, Zod schemas, event names, and contract versions. No HTTP client,
queues, auth, DB access, or producer behavior.

### `@gscdump/sdk`

Consumer SDK for hosted gscdump.com integrations. Owns the pluggable HTTP
client, websocket client, and webhook receiver helpers. Re-exports
`@gscdump/contracts` for convenience, but does not own webhook production,
delivery, retry policy, or gscdump.com storage behavior.

### `@gscdump/mcp` (frozen)

MCP server. Ships `gscdump-mcp` bin (env-var auth only); `@gscdump/cli`'s `mcp` command wraps the same server with interactive auth/config loading.

MCP tools: `list-sites`, `list-sites-with-sitemaps`, `list-sitemaps`, `get-sitemap`, `submit-sitemap`, `delete-sitemap`, `fetch-pages`, `fetch-keywords`, `fetch-countries`, `fetch-devices`, `query`, `inspect-url`, `request-indexing`, `get-indexing-status`, `batch-request-indexing`, `batch-inspect-urls`.

## Data flow

```
Auth (token or OAuth credentials)
        │
        ▼
┌────────────────────────────────────────┐
│  gscdump (core)                        │
│  REST client · query builder · engine  │
└────────────────────────────────────────┘
        │                      │
        │ live API             │ DuckDB / Parquet
        ▼                      ▼
┌────────────────┐   ┌─────────────────────────┐
│ live commands  │   │  sync → store → query   │
│ sites · sitemaps│  │  analyze · dump         │
│ inspect        │   │  store {stats,compact,  │
│                │   │         gc,export}      │
└────────────────┘   └─────────────────────────┘
        │                      │
        └──────────┬───────────┘
                   ▼
            @gscdump/cli
```

## Glossary

- **Schema** — canonical drizzle pg-core tables in `@gscdump/engine/schema`. DuckDB (both wasm + node) executes pg-flavored SQL natively. Abstract `SCHEMAS: Record<TableName, TableSchema>` for the parquet writer is *derived* from drizzle via `getTableConfig`; `TABLE_METADATA` carries sortKey + schema version.
- **Engine** — storage runtime. DuckDB-Node primitives live at `@gscdump/engine/node` (`createNodeHarness` for one-call wiring; consumers wrap a `StorageEngine` as an `AnalysisQuerySource` via `createEngineQuerySource` from `@gscdump/engine/source`). DuckDB-WASM at `@gscdump/engine-duckdb-wasm` (browser path uses `createAttachedTableSource`); SQLite/D1 at `@gscdump/engine-sqlite` (`createEngine`); GSC live-API at `@gscdump/engine-gsc-api` (`createGscApiQuerySource` / `createLiveGscSource`). All produce a `QuerySource`.
- **Source** (`AnalysisQuerySource`) — query abstraction in `@gscdump/engine/source`, consumed by analyzers. Single interface; `queryRows` always present, `executeSql` opt-in via `capabilities.executeSql` (with the matching method). Capability flags (`adapter`, `executeSql`, `attachedTables`, `fileSets`, planner caps) are the single source of truth for what a source supports — the analyzer dispatcher rejects mismatches with `AnalyzerCapabilityError`. `executeSql` takes optional `fileSets` for `{{FILES}}` substitution.
- **Adapter** (`ResolverAdapter<TableKey>`) — dialect-specific translator in `@gscdump/engine/resolver`. Compiles `BuilderState` → `{ sql, params }` against a drizzle schema. `pgResolverAdapter` is shared by DuckDB (wasm + node) — single-tenant; `sqliteResolverAdapter` in `@gscdump/engine-sqlite` scopes by `site_id`. Built via `createResolverAdapter`.
- **Driver** — low-level runtime binding (e.g. DuckDB-WASM `AsyncDuckDB` handle, sqlite-proxy executor, R2 bucket). The engine wraps a driver; analyzers never see one.
- **Analyzer** (`Analyzer<P, R>`) — pure contract `{ id, requires, build, reduce }` in `@gscdump/engine/analyzer`. `ROW_ANALYZERS` (10, for GSC live API + in-memory) + `SQL_ANALYZERS` (29) — both arrays exported from `@gscdump/analysis`. Dispatched by `runAnalyzerFromSource(source, params, registry)`; capability mismatches throw `AnalyzerCapabilityError`.
- **Rollup** (`RollupDef`) — post-sync JSON aggregate in `@gscdump/engine/rollups`. Each rollup runs a SQL aggregation against the tenant's facts via `engine.runSQL` and writes a `RollupEnvelope<T>` to `u_<u>/<s>/rollups/<id>__v<ts>.json`. `DEFAULT_ROLLUPS` ships `daily_totals` (with `anonymizedImpressionsPct`), `weekly_totals`, `top_pages_28d`, `top_keywords_28d`, `indexing_metadata`. Format rule documented in `rollups.ts`: JSON for small/aggregate; parquet reserved for future top-N tables that need server-side WHERE filtering.
- **Entity** — per-site slow-changing state, distinct family from the time-series facts. Three stores in `@gscdump/engine/entities`: URL inspections (per-URL latest + monthly history shards, keyed by FNV-1a hash), sitemap snapshots, indexing-metadata events. Point-lookup-by-id, not scanned. JSON-backed v1; SQLite-per-site swap is a backend change behind the same interface.
- **Manifest authority** — R2-native `ManifestStore` (`@gscdump/engine/r2-manifest`) uses a HEAD pointer + immutable snapshot per `(siteId, table)` shard. Concurrent writers CAS on HEAD via `onlyIf.etagMatches`; readers fetch pointer + snapshot (both cacheable). Filesystem `ManifestStore` stays the single-writer default for CLI use.
- **searchType partition** — first-class partition dimension on `WriteCtx`/`ManifestEntry`/`SyncStateScope`. Non-`web` types (`discover`, `news`, `googleNews`, `image`, `video`) get a `<table>/<searchType>/` path segment; `web` preserves legacy paths for back-compat. Compaction and sync state are keyed per-(bucket, searchType).
- **Compaction tier** (`CompactionTier`) — `raw | d7 | d30 | d90` on each `ManifestEntry`. `compactTiered` in `compaction.ts` runs raw→d7 (weekly) / d7→d30 (monthly) / d30→d90 (quarterly) based on per-tier age thresholds. The `tier` field makes input cohorts unambiguous so later tiers don't re-pick their own output.

## Build system

- **obuild** for all packages
- **pnpm catalogs** for centralized dependency versions
- **ESM only** (`"type": "module"`)
