# Architecture

Pipeline: **GSC API → DuckDB → analysis → CLI**. See [`ROADMAP.md`](./ROADMAP.md) for current status and next actions.

## Monorepo layout

```
gscdump/
├── packages/
│   ├── gscdump/      # Core: REST client, query builder, Parquet/DuckDB engine
│   ├── analysis/     # @gscdump/analysis: row-based + SQL-native analyzers
│   ├── cli/          # @gscdump/cli: CLI entry (gscdump bin)
│   ├── cloud/        # @gscdump/cloud: cloud SDK + cloud CLI (frozen)
│   └── mcp/          # @gscdump/mcp: MCP server (frozen)
└── pnpm-workspace.yaml
```

Web app lives separately at https://github.com/harlan-zw/gscdump.com.

Dependency graph:

- `@gscdump/cli` → `gscdump`, `@gscdump/analysis`, `@gscdump/mcp`
- `@gscdump/analysis` → `gscdump`
- `@gscdump/cloud` → `gscdump` (frozen)
- `@gscdump/mcp` → `gscdump` (frozen)

`@gscdump/cloud` and `@gscdump/mcp` are `private: true` and frozen; builds + tests pass, no new features.

## Packages

### `gscdump` (core)

GSC REST wrapper + typed query builder + append-only Parquet-on-object-store engine. Edge-compatible (`fetch`/`ofetch`); no `node:*` in core paths.

Subpath exports:

| Export | Purpose |
|---|---|
| `gscdump` | `googleSearchConsole(auth)` client + REST helpers |
| `gscdump/query` | Builder, columns, operators, resolver, date helpers |
| `gscdump/driver` | `GscDriver` interface (type-only) |
| `gscdump/shared` | Cross-package type primitives |
| `gscdump/shared/analysis` | Analysis contracts only (`AnalysisParams`, `AnalysisResult`, `AnalysisTool`) |
| `gscdump/shared/driver` | Driver contracts only (`DriverSite`, `DriverQueryResult`, `DriverInspectResult`, ...) |
| `gscdump/shared/snapshot` | Snapshot metadata contract (`SnapshotIndex`) |
| `gscdump/analytics` | Storage engine, interfaces, DuckDB codec/executor, `createRowAccumulator`, `bindLiterals` (edge-safe) |
| `gscdump/analytics/contracts` | Engine/storage contracts only (`StorageEngine`, `Row`, `TableName`, ...) |
| `gscdump/analytics/schema` | Table metadata primitives (`SCHEMAS`, `allTables`, `inferTable`, ...) |
| `gscdump/analytics/planner` | BuilderState → analytics SQL + partition planning (`resolveToSQL`, `enumeratePartitions`, ...) |
| `gscdump/analytics/tenant` | Tenant/site key primitive (`encodeSiteId`) |
| `gscdump/analytics/normalize` | URL normalization primitive (`normalizeUrl`) |
| `gscdump/analytics/ingest` | GSC row → storage row primitives (`createRowAccumulator`, `transformGscRow`) |
| `gscdump/analytics/sql` | SQL literal binding helpers (`bindLiterals`, `formatLiteral`) |
| `gscdump/analytics/node` | Node-only DuckDB handle |
| `gscdump/analytics/filesystem` | Node-only `DataSource` + `ManifestStore` adapters |
| `gscdump/analytics/http` | Read-only HTTP `DataSource` (signed URLs, Range) |
| `gscdump/analytics/hyparquet` | Pure-JS `ParquetCodec` (hyparquet-writer/hyparquet); optional `readRows` override for delegated reads |
| `gscdump/analytics/r2` | Cloudflare R2 `DataSource` (structurally typed against `R2Bucket`; no `@cloudflare/workers-types` hard dep) |

`@duckdb/duckdb-wasm`, `@googleapis/*`, `hyparquet`, and `hyparquet-writer` are optional peers; non-CLI consumers don't pay the install cost.

Boundary rule: sibling packages should prefer the narrowest `gscdump/*` subpath that matches the primitive they need. The top-level `gscdump/shared` and `gscdump/analytics` barrels remain for compatibility, but new internal imports should use the scoped exports above.

See [`packages/gscdump/ARCHITECTURE.md`](./packages/gscdump/ARCHITECTURE.md) for subsystem detail.

### `@gscdump/analysis`

Row-based analyzers + SQL-native dispatcher + typed query primitives for DuckDB-WASM / D1. Moved out of core in Phase 0.

| Export | Purpose |
|---|---|
| `@gscdump/analysis` | Pure row-based analyzers (`analyzeStrikingDistance`, `analyzeOpportunity`, `analyzeMovers`, `analyzeDecay`, `analyzeBrandSegmentation`, `analyzeClustering`, `analyzeConcentration`, `analyzeSeasonality`); fetch wrappers; `padTimeseries`; contract types (`AnalysisParams`, `AnalysisResult`, `AnalysisTool`). |
| `/duckdb` | `analyzeWithDuckDB(deps, ctx, params)`, SQL-native dispatcher (21 analyzers wired); `attachParquetIndex`, `attachSnapshotIndex` for DuckDB session wiring. |
| `/browser` | DuckDB-WASM primitives: `createInsightRunner({ db, conn })`, `resolveWindow`, `scopeFor` / `mergeScope`, drizzle schema, `strikingMomentum`, vendored drizzle-orm DuckDB-WASM adapter. |
| `/sqlite` | D1 / sqlite-proxy mirror: `createSqliteInsightRunner({ executor })`, `compileSqlite`, `agg*` helpers, runtime-builder primitives (`colRef`, `dimColumn`, `metricSql`, ...), drizzle schema. |
| `/query` | Dialect-neutral composers for runtime `BuilderState` (pass a `ResolverAdapter` from `/sqlite` or `/browser`). |
| `/window` | `resolveWindow({ preset, comparison, anchor })` — canonical date windows, no DB. |

Peer: `gscdump`. `@duckdb/duckdb-wasm` optional peer for `/browser` + `/duckdb`.

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

## Build system

- **obuild** for all packages
- **pnpm catalogs** for centralized dependency versions
- **ESM only** (`"type": "module"`)
