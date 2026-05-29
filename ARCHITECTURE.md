# Architecture

`gscdump` is a pnpm monorepo. This document is the high-level map; per-package
READMEs and the root `CLAUDE.md` carry the operational detail.

## Monorepo Layout

```
.
├── package.json             # root workspace config
├── pnpm-workspace.yaml      # workspace + catalog definitions
├── tsconfig.json            # root TS project references
├── packages/
│   ├── gscdump/              # gscdump: edge-safe REST client + query builder
│   ├── engine/               # @gscdump/engine: Parquet/DuckDB storage, planner, adapters
│   ├── engine-duckdb-wasm/   # @gscdump/engine-duckdb-wasm: DuckDB-WASM runtime adapter
│   ├── engine-sqlite/        # @gscdump/engine-sqlite: SQLite runtime adapter
│   ├── engine-gsc-api/       # @gscdump/engine-gsc-api: live GSC API source adapter
│   ├── analysis/             # @gscdump/analysis: analyzers + reports + source dispatch
│   ├── contracts/            # @gscdump/contracts: hosted API contracts
│   ├── sdk/                  # @gscdump/sdk: hosted API HTTP clients
│   ├── cloudflare/           # @gscdump/cloudflare: Cloudflare Workers / R2 helper primitives
│   └── cli/                  # @gscdump/cli: CLI (dump, query, sync, analyze, report) + bundled MCP server
├── examples/
│   └── nuxt-dashboard/       # Example Nuxt dashboard app
└── tooling & config (eslint, tsconfig, vitest, scripts)
```

## Package Dependencies

- `gscdump` (no internal deps; base layer)
- `@gscdump/engine` → `gscdump`
- `@gscdump/engine-duckdb-wasm` → `@gscdump/engine`
- `@gscdump/engine-sqlite` → `@gscdump/engine`
- `@gscdump/engine-gsc-api` → `gscdump`, `@gscdump/engine`
- `@gscdump/analysis` → `gscdump`, `@gscdump/engine`, `@gscdump/engine-gsc-api`
- `@gscdump/cloudflare` → `gscdump`, `@gscdump/engine`, `@gscdump/engine-gsc-api`
- `@gscdump/cli` → `gscdump`, `@gscdump/engine`, `@gscdump/engine-gsc-api`, `@gscdump/analysis`
- `@gscdump/sdk` → `@gscdump/contracts`

`gscdump` is the dependency-free base. Everything else builds on it. No cycles.

## Data Flow

### Sync (write path)

```
GSC API → fetchSearchAnalyticsAll (gscdump)
        → transformGscRow / RowAccumulator (@gscdump/engine ingest)
        → Sink (in-memory | local Iceberg | pipeline)
        → Parquet files + manifest (filesystem | R2)
```

### Query (read path)

```
gsc() query builder (gscdump/query)
        → BuilderState → compileLogicalQueryPlan (@gscdump/engine planner)
        → resolveToSQL (@gscdump/engine resolver)
        → DuckDB (WASM | node) over Parquet
        → typed rows
```

### Analyze

```
rows → analyzer (@gscdump/analysis)
     → AnalyzerResult (metrics, findings, series)
```

## Runtime Targets

| Package | Node | Browser | Workerd |
| --- | --- | --- | --- |
| `gscdump` | ✅ | ✅ | ✅ |
| `@gscdump/engine` (core) | ✅ | ✅ | ✅ |
| `@gscdump/engine/node` | ✅ | ❌ | ❌ |
| `@gscdump/engine-duckdb-wasm` | ✅ | ✅ | ⚠️ |
| `@gscdump/analysis` | ✅ | ✅ | ✅ |
| `@gscdump/sdk` | ✅ | ✅ | ✅ |
| `@gscdump/cloudflare` | ⚠️ | ❌ | ✅ |
| `@gscdump/cli` | ✅ | ❌ | ❌ |

## Key Design Decisions

See `docs/adr/` for the full set. Highlights:

- **Browser engine uses attached tables** (ADR-0001): DuckDB-WASM reads Parquet
  via `parquet_scan` over HTTP range requests, no full download.
- **Analysis re-exports engine contracts** (ADR-0002): one import surface for
  consumers; `@gscdump/analysis` is the public analyzer API.
- **execute-sql is method presence** (ADR-0003): capability detection by probing
  for the method, not a flag.
- **Analyzer registration is build-time** (ADR-0004): the default registry is
  assembled at module load, no runtime plugin scan.
- **Export surface tracks the two consumers** (ADR-0012): subpaths exist only
  where `gscdump.com` or `nuxtseo.com` import them; internal wiring stays private.

## MCP Server

The MCP server lives inside `@gscdump/cli` (`src/mcp/`), exposed through the
`gscdump mcp` command (interactive auth/config loading). There is no separate
`@gscdump/mcp` package. MCP tools: `list-reports`, `run-report`, `list-sites`,
`inspect-url`, `batch-inspect`, `request-indexing`, `list-sitemaps`,
`get-indexing-status`. Handler signature is
`(args, context) => Promise<CallToolResult>`.

## Testing

- Unit/integration: `vitest` (`pnpm test`).
- Real-runtime workers: `pnpm test:workers` (Cloudflare workerd pool).
- Browser/OPFS: `pnpm test:browser` (chromium).
- E2E: `pnpm test:e2e` (skips live Google calls without BYOK env).

## Where Things Live

| Concern | Location |
| --- | --- |
| REST client, query builder | `gscdump` |
| Storage, planner, resolver, adapters | `@gscdump/engine` |
| Analyzers, reports | `@gscdump/analysis` |
| Hosted API contracts | `@gscdump/contracts` |
| Hosted API HTTP clients | `@gscdump/sdk` |
| Cloudflare/R2 primitives | `@gscdump/cloudflare` |
| CLI commands + MCP server | `@gscdump/cli` |

## Conventions

- Packages ship ESM only (`"type": "module"`).
- Build with `obuild` (rolldown). Type checks with `tsc --noEmit`.
- Tests with `vitest`. Real-runtime tests via Cloudflare/browser pools.
- Catalog versions in `pnpm-workspace.yaml`; packages reference `catalog:`.

## See Also

- `docs/adr/` — architecture decision records.
- per-package `README.md` — package-level detail.
- root `CLAUDE.md` — agent operational rules.
