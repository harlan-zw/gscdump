# Architecture

Pipeline: **GSC API → DuckDB → analysis → CLI**. See [`ROADMAP.md`](./ROADMAP.md) for current status and next actions.

## Monorepo layout

```
gscdump/
├── packages/
│   ├── gscdump/              # Core: REST client, query builder, driver/tenant/normalize primitives (edge-safe)
│   ├── engine/               # @gscdump/engine: Parquet/DuckDB storage engine + canonical drizzle pg-core schema + SQL resolver kit
│   ├── engine-wasm/          # @gscdump/engine-wasm: DuckDB-WASM engine adapter (browser + R2 parquet)
│   ├── engine-sqlite/        # @gscdump/engine-sqlite: SQLite / D1 engine adapter
│   ├── engine-duckdb-node/   # @gscdump/engine-duckdb-node: Node DuckDB engine + SQL-native analyzers (browser-attached + server-side)
│   ├── analysis/             # @gscdump/analysis: row-based analyzers + analyzer registry + source/dispatcher
│   ├── cli/                  # @gscdump/cli: CLI entry (gscdump bin)
│   ├── cloud/                # @gscdump/cloud: cloud SDK + cloud CLI (frozen)
│   └── mcp/                  # @gscdump/mcp: MCP server (frozen)
└── pnpm-workspace.yaml
```

Web app lives separately at https://github.com/harlan-zw/gscdump.com.

Dependency graph:

- `@gscdump/cli` → `gscdump`, `@gscdump/engine`, `@gscdump/engine-duckdb-node`, `@gscdump/analysis`, `@gscdump/mcp`
- `@gscdump/analysis` → `gscdump`, `@gscdump/engine`, `@gscdump/engine-wasm`, `@gscdump/engine-sqlite`, `@gscdump/engine-duckdb-node`
- `@gscdump/engine-duckdb-node` → `gscdump`, `@gscdump/engine`, `@gscdump/analysis` (query + source + analyzer subpaths)
- `@gscdump/engine-wasm` → `gscdump`, `@gscdump/engine`, `@gscdump/engine-duckdb-node`, `@gscdump/analysis/period` (type-only)
- `@gscdump/engine-sqlite` → `gscdump`, `@gscdump/engine`, `@gscdump/analysis` (source + period subpaths)
- `@gscdump/engine` → `gscdump`
- `@gscdump/cloud` → `gscdump`, `@gscdump/analysis` (type-only); frozen
- `@gscdump/mcp` → `gscdump` (frozen)

Canonical schema source of truth: `@gscdump/engine/schema` exports drizzle pg-core tables (`pages`, `keywords`, `countries`, `devices`, `page_keywords`). Every other representation — the abstract `SCHEMAS: Record<TableName, TableSchema>` for parquet writer / planner, the sqlite-core tables in `@gscdump/engine-sqlite` — is derived from or validated against this.

`@gscdump/cloud` and `@gscdump/mcp` are `private: true` and frozen; builds + tests pass, no new features.

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
| `@gscdump/engine/resolver` | SQL composition kit: `pgResolverAdapter`, `createResolverAdapter`, `compilePg`/`compileSqlite`, `resolveToSQL` + comparison composers, `createSqlQuerySource`, source contracts (`SqlQuerySource`, `RowQuerySource`, `AnalysisQuerySource`, `QueryRow`, `FileSet`), `assertSchemaInSync`. |
| `@gscdump/engine/planner` | Logical → SQL compiler + partition planning (`resolveToSQL`, `enumeratePartitions`). |
| `@gscdump/engine/ingest` | GSC row → storage row (`createRowAccumulator`, `transformGscRow`). |
| `@gscdump/engine/sql` | SQL literal binding (`bindLiterals`, `formatLiteral`). |
| `@gscdump/engine/node` | Node-only DuckDB handle. |
| `@gscdump/engine/node-harness` | Node-only: `createNodeHarness({ dataDir, userId? })` — wires filesystem + DuckDB into a ready `StorageEngine` in one call. |
| `@gscdump/engine/filesystem` | Node-only `DataSource` + `ManifestStore` adapters. |
| `@gscdump/engine/http` | Read-only HTTP `DataSource` (signed URLs, Range). |
| `@gscdump/engine/hyparquet` | Pure-JS `ParquetCodec`. |
| `@gscdump/engine/r2` | Cloudflare R2 `DataSource` (structurally typed against `R2Bucket`). |

Optional peers: `@duckdb/duckdb-wasm`, `hyparquet`, `hyparquet-writer`.

Boundary rule: sibling packages should prefer the narrowest subpath that matches the primitive they need. Analysis contracts (`AnalysisParams`, `AnalysisResult`, `AnalysisTool`) live in `@gscdump/analysis` (not core, not engine).

See [`packages/gscdump/ARCHITECTURE.md`](./packages/gscdump/ARCHITECTURE.md) for subsystem detail.

### `@gscdump/analysis`

Row-based analyzers, analyzer registry/dispatcher, source factories, typed query-analyzer plans.

| Export | Purpose |
|---|---|
| `@gscdump/analysis` | Row-based analyzers (`analyzeStrikingDistance`, `analyzeOpportunity`, `analyzeMovers`, `analyzeDecay`, `analyzeBrandSegmentation`, `analyzeClustering`, `analyzeConcentration`, `analyzeSeasonality`); contract types (`AnalysisParams`, `AnalysisResult`, `AnalysisTool`); re-exports from `/period`, `/source`, `/analyzer`. |
| `/analyzer` | Analyzer contracts (`Analyzer`, `Capability`, `Plan`, `SqlPlan`, `RowQueriesPlan`, `FileSet`), `ROW_ANALYZERS`, `createAnalyzerRegistry`, dispatcher (`runAnalyzerFromSource`, `AnalyzerCapabilityError`). Consumed by engine packages that contribute analyzers. |
| `/period` | Window primitives: `resolveWindow`, `AnalysisPeriod`, `ComparisonPeriod`, `padTimeseries`, `windowToPeriod`, `windowToComparisonPeriod`. |
| `/query` | Query-analyzer plan builders (`buildDataQueryPlan`, `buildDataDetailPlan`) for `data-query` / `data-detail` analyzers. SQL composition primitives moved to `@gscdump/engine/resolver`. |
| `/source` | `AnalysisQuerySource` discriminated union, source factories (`createGscApiQuerySource`, `createBrowserQuerySource`, `createSqliteQuerySource`, `createEngineQuerySource`, `createInMemoryQuerySource`), unified dispatcher (`analyzeFromSource`). Re-exports source contracts from `@gscdump/engine/resolver`. |
| `/semantic` | Embedding-backed analyzers (e.g. `analyzeContentGap`). Lazy `@huggingface/transformers` peer. |

Peer: `gscdump`, `@gscdump/engine`, `@gscdump/engine-duckdb-node` (for `defaultAnalyzerRegistry` only).

### `@gscdump/engine-wasm`

Browser DuckDB-WASM engine adapter: `createEngine({ runner }) → SqlQuerySource`, plus primitives (`createInsightRunner({ db, conn })`, `scopeFor`/`mergeScope`, `strikingMomentum`, `bootDuckDBWasm`, `attachParquetTables`/`attachParquetUrlTables`, `createBrowserAnalysisRuntime`, vendored drizzle-orm DuckDB-WASM adapter). Re-exports canonical drizzle schema + `browserResolverAdapter` (alias for `pgResolverAdapter`) from `@gscdump/engine`. Optional peer: `@duckdb/duckdb-wasm`.

### `@gscdump/engine-sqlite`

D1 / sqlite-proxy engine adapter: `createEngine({ executor, siteId }) → SqlQuerySource`, plus `createSqliteInsightRunner({ executor })`, `sqliteResolverAdapter`, `agg*` helpers, drizzle sqlite-core schema (superset of canonical columns; drift-checked).

### `@gscdump/engine-duckdb-node`

Node DuckDB engine + SQL-native analyzer collection (`SQL_ANALYZERS`, 29 analyzers). Exports `createEngine({ engine, ctx }) → SqlQuerySource`, `analyzeInBrowser` (browser attached-table runner), `attachParquetIndex`, `attachSnapshotIndex`. Consumed by CLI's local-analyze path and by `defaultAnalyzerRegistry`.

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
| `store stats` / `store compact` / `store gc` / `store export` | Local store admin |
| `auth` | Manage credentials |
| `config` | Manage CLI config |
| `mcp` | Wraps `@gscdump/mcp` with CLI-side auth/config |

**Read-path default:** `query`, `dump`, `analyze` read from DuckDB. If the request's date range isn't covered by the sync watermark, fail with an actionable `run gscdump sync first`. `--live` opts into the live GSC API. `sites`, `sitemaps`, `inspect` are always live; they don't store.

### `@gscdump/cloud` (frozen)

Cloud SDK + cloud CLI. Owns `CloudGscDriver` interface, all `Cloud*` types, `createCloudDriver`, `isCloudDriver`. Ships `gscdump-cloud` bin with `register` / `unregister` / `sync` / `sitemaps` / `indexing` subcommands. Loads session from `GSCDUMP_CLOUD_SESSION` env or `~/.config/gscdump/cloud-tokens.json`.

Revival trigger: when gscdump.com's web app needs to import runtime code from `@gscdump/cloud` (not just shared types).

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
- **Engine** — storage runtime. DuckDB-Node at `@gscdump/engine-duckdb-node`; DuckDB-WASM at `@gscdump/engine-wasm`; SQLite/D1 at `@gscdump/engine-sqlite`. Each exposes `createEngine(config) → QuerySource`.
- **Source** (`AnalysisQuerySource`) — query abstraction in `@gscdump/engine/resolver`, consumed by analyzers. Discriminated union of `RowQuerySource` (typed `BuilderState` only — GSC API, in-memory) and `SqlQuerySource` (typed `BuilderState` + raw SQL — DuckDB-WASM, SQLite, Node engine). `executeSql` takes optional `fileSets` for `{{FILES}}` substitution.
- **Adapter** (`ResolverAdapter<TableKey>`) — dialect-specific translator in `@gscdump/engine/resolver`. Compiles `BuilderState` → `{ sql, params }` against a drizzle schema. `pgResolverAdapter` is shared by DuckDB (wasm + node) — single-tenant; `sqliteResolverAdapter` in `@gscdump/engine-sqlite` scopes by `site_id`. Built via `createResolverAdapter`.
- **Driver** — low-level runtime binding (e.g. DuckDB-WASM `AsyncDuckDB` handle, sqlite-proxy executor, R2 bucket). The engine wraps a driver; analyzers never see one.
- **Analyzer** (`Analyzer<P, R>`) — pure contract `{ id, params, requires, build, reduce }` in `@gscdump/analysis/analyzer`. `ROW_ANALYZERS` (8, for GSC live API + in-memory) + `SQL_ANALYZERS` (29, in `@gscdump/engine-duckdb-node`). Dispatched by `runAnalyzerFromSource`; capability mismatches throw `AnalyzerCapabilityError`.

## Build system

- **obuild** for all packages
- **pnpm catalogs** for centralized dependency versions
- **ESM only** (`"type": "module"`)
