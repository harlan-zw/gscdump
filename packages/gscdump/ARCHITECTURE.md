# Package architecture — `gscdump` (core)

`gscdump` is the edge-safe core: GSC REST client, typed query builder, driver/tenant/normalize primitives. Storage engine, analyzers, CLI, and MCP server live in sibling packages. See [`/ARCHITECTURE.md`](../../ARCHITECTURE.md) for the monorepo-wide picture and [`/ROADMAP.md`](../../ROADMAP.md) / [`/PIVOT.md`](../../PIVOT.md) for status.

## Scope

- **In**: REST wrappers (`searchAnalytics`, `sites`, `sitemaps`, `urlInspection`, `indexing`), async-generator pagination, typed query builder + logical planner, cross-package contract types (`DriverSite`, `AnalysisParams`, …), tenant key + URL normalization primitives.
- **Out**: Parquet/DuckDB storage (→ `@gscdump/engine`), analyzers + source dispatchers (→ `@gscdump/analysis`), engine adapters (→ `@gscdump/engine-*`), CLI (→ `@gscdump/cli`), cloud SDK (→ `@gscdump/cloud`, frozen), MCP server (→ `@gscdump/mcp`, frozen).

Edge-safety rule: no `node:*`, no `@duckdb/*`, no `hyparquet*`. Install on workers, edge runtimes, browsers. Optional peers `@googleapis/indexing` + `@googleapis/searchconsole` are only needed if callers use the REST helpers.

## Subsystems

| Subsystem | Entry | What it does |
|---|---|---|
| REST client | `src/api/`, `src/core/` | `googleSearchConsole(auth)` returns a client with async generators for `searchAnalytics.query`, `sites`, `sitemaps`, `urlInspection`, `indexing`. `fetch`/`ofetch`-based. |
| Query builder | `src/query/` | `gsc.select(page, query).where(between(date, …)).limit(1000)` compiles to GSC request bodies (`resolveToBody`) or feeds the planner that `@gscdump/engine`'s resolver kit turns into SQL. |
| Logical plan | `src/query/plan.ts` | `buildLogicalPlan`, comparison-plan primitives, planner capability types. The dialect-specific SQL compiler lives in `@gscdump/engine/resolver`. |
| Contracts | `src/contracts.ts`, `src/driver.ts` | Cross-package type primitives — `DriverSite`, `DriverQueryResult`, `DriverSitemap`, `DriverInspectResult`, `AnalysisParams`, `AnalysisResult`, `AnalysisTool`, `TenantCtx`, `SnapshotIndex`. Type-only. |
| Tenant key | `src/tenant.ts` | `encodeSiteId(siteUrl)` — deterministic GSC-siteUrl → filesystem-safe string. Detects `sc-domain:` vs URL-prefix. |
| URL normalize | `src/normalize.ts` | `normalizeUrl(input)` — write-time collapse of full URLs to pathname+search so read-side filters work uniformly across domain + URL-prefix properties. Engines apply this automatically. |

## Subpath exports

| Export | Purpose |
|---|---|
| `gscdump` | REST client + types (`googleSearchConsole`, error types). |
| `gscdump/query` | Builder, columns, operators, resolver, date helpers, planner types. |
| `gscdump/query/plan` | Logical planner internals (`buildLogicalPlan`, comparison-plan primitives). |
| `gscdump/contracts` | Shared type primitives (type-only). |
| `gscdump/driver` | `DriverSite`, `DriverQueryResult`, `DriverSitemap`, `DriverInspectResult`, … (type-only). |
| `gscdump/tenant` | `encodeSiteId`. |
| `gscdump/normalize` | `normalizeUrl`. |

Sibling packages should import the narrowest subpath that matches the primitive they need (e.g. `gscdump/contracts` or `gscdump/driver` instead of the root barrel) so consumers don't pay the REST-client bundle cost for a type import.

## Query builder → live vs. stored

`BuilderState` is lossless: the same builder drives the live GSC call (`resolveToBody`) and offline DuckDB/SQLite queries (via the resolver kit in `@gscdump/engine/resolver`). Adding a dimension or operator here flows through both paths without duplication.

## Dependencies

- Runtime: `dayjs`, `defu`, `ofetch`, `ufo`.
- Optional peers: `@googleapis/indexing`, `@googleapis/searchconsole` (only for REST helpers).
- No sibling-package imports. Everything else in the monorepo depends on this.
