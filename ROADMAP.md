# Roadmap

Last updated: 2026-04-27

Unified successor to `PIVOT.md`, `NEXT_STEPS.md`, `NEXT_STEPS-example.md`,
`PORTING_PLAN.md`, `EXTRACTION_PLAN.md`. Only open work lives here; shipped
items are recorded in git history.

## Where we are

Seven packages:

- **`gscdump`** — REST client + query builder. Edge-compatible.
- **`@gscdump/engine`** — parquet/R2 storage + tiered compaction + R2 manifest
  CAS + rollups + entity stores + tenant-scoped GDPR purge. All 7 PIVOT items
  shipped v1.
- **`@gscdump/engine-wasm`**, **`@gscdump/engine-sqlite`**,
  **`@gscdump/engine-duckdb-node`** — engine adapters.
- **`@gscdump/analysis`** — analyzers + insight runners + drizzle schemas.
- **`@gscdump/nuxt-analytics`** — Nuxt layer (`extends`). Source provider seam,
  capability gates, design-system components (`GscHero`, `DataList`,
  `QueryLabel`, `CommandPalette`, `PerformanceChart`, `Ui*`), entity routes.
- **`@gscdump/cli`** — CLI + MCP server.
- **`@gscdump/mcp`**, **`@gscdump/cloud`** — frozen.

Example consumer: `examples/nuxt-dashboard` — exercises free (GSC API) and
pro (engine/DuckDB) tiers, 11 site pages (overview, queries, pages, countries,
indexing, sitemaps, insights, search-appearance, analyze), command palette,
tier switcher, and `dev:local` / `dev:origin` / `dev:consumer` scripts for
each layer mode.

## Last session (2026-04-24)

- Unified 5 planning docs into this roadmap.
- Added `dev:local` / `dev:origin` / `dev:consumer` scripts (flips
  `GSCDUMP_ANALYTICS_MODE`).
- Documented schema-version migration policy in
  `packages/engine/src/schema.ts`.
- Shipped tenant-scoped GDPR purge: `StorageEngine.purgeTenant` +
  `ManifestStore.purgeTenant` on filesystem, R2, D1 adapters.
- Drained storage polish: `encodeRowsToParquetFlex`, parquet rollup format
  (`topKeywords28dParquetRollup`), SQLite `InspectionStore` (node + browser
  drivers), `topCountries28dRollup`, `search_appearance` fact table
  end-to-end, R2 contention harness + `onEvent` telemetry,
  `StorageEngine.purgeUrls` per-URL GDPR purge.
- `/sites/[id]/search-appearance.vue` in layer + example; layer `SiteTabs`
  gained the tab.
- Refreshed stale export snapshots.

## Open work (prioritized)

### P1 — consumer adoption

1. **Phase 3: migrate `gscdump.com` to consume `@gscdump/nuxt-analytics@^0.5`**
   — swap `link:@gscdump/*` for `^0.5.0`, delete duplicated files,
   register session auth provider, origin-mode config, feature-flagged
   rollout. Blocked on Phase 0 audit fixes in the `gscdump.com` repo.
2. **Phase 5: onboard `nuxtseo.com` as consumer-mode adopter** — layer
   auth provider resolving pro-user GSC credentials, delete ~1000 lines of
   `useProGscdump*` composables, snapshot-test pro dashboard pages.
   Depends on 1.

### P2 — 1.0 cut

3. **Publish `@gscdump/nuxt-analytics@1.0.0`** once the gscdump.com
   adoption proves the API surface in production. Engine + layer contract
   tests already in place; the major bump signals API stability after at
   least one real consumer migration validates it.

### P3 — polish

4. **Playwright smoke on example** — boot under each mode and assert the
   `[data-testid=analytics-mode]` indicator matches. Pairs with the
   existing layer-mode contract test in `tests/example-modes.test.ts` to
   cover behavior beyond config-time validation.
5. **Layer page-primitive refactor** — `PageHeader`, `DashboardPage`,
   `SectionHeader` primitives already in use on countries, insights,
   search-appearance, indexing (list + drill-down), sitemaps (list +
   drill-down). Remaining 6 pages with inline markup: overview
   (`index.vue`), analyze, pages list/detail, queries list/detail.
   Refactor alongside 1 / 2 adoption.
6. **Ongoing policy**: every layer change updates example in same PR;
   breaking = major bump; shared telemetry.

### Deferred

- **`DashboardShell` extraction** — until a second consumer's sidebar
  shape disagrees.
- **Dialect split** — two subpaths (`/browser`, `/sqlite`) vs. factory.
  Revisit at a third target.

## Risks to monitor

- **R2 1-write/sec/key cap on `manifest/HEAD`** — per-`searchType` sharding
  if `conditionalRejections` climbs. Run the contention harness
  (`pnpm --filter @gscdump/engine r2-harness`) against a real R2 bucket
  before first production rollout; wire the `R2ManifestStore` `onEvent`
  telemetry into dashboard metrics once live.
- **`union_by_name = true` masking schema drift** — read path silently fills
  missing columns with NULL. Relies on `schemaVersion` for explicit version
  checks once type-changing migrations land.
- **GSC API quota on free-tier fanout** — 1200 QPM/site shared. Multi-site
  overview + date picker moves can burn quota fast. Watch 429s.
- **Tier cookie is client-controlled** — fine for demo; production hosts
  MUST derive tier from a billing source.
- **`enumeratePartitions` size growth** — daily+weekly+monthly+quarterly now
  emits ~433 strings for a 1-year query. Marginal; flag if planner perf
  surfaces.
- **Inspection store unbounded growth** — add `gscdump entities prune
  --older-than 365d` if storage becomes a concern.
- **Cross-tenant manifest scaling** — 1000+ tenants per shard stresses R2
  LIST on dashboard bootstrap. Shard by `(userId-prefix, siteId, table)`
  if we hit that scale.

## Explicit non-goals

- **Bloom filters** — hyparquet-writer doesn't support them; revisit if
  upstream lands the feature.
- **Opt-in slice tables** (`keywords_country`, `pages_country`) — rollups
  answer most cross-cuts.
- **Mega fact-table consolidation** — GSC's per-dim aggregation lossiness
  makes a single all-dimensions fact table silently incorrect.
- **DataForSEO / Lighthouse / CrUX / AI features in the layer** — stay in
  nuxtseo.com.
- **Feature-flag scaffolding in the layer** — features ship or don't.
- **Billing / licensing / onboarding in the layer** — assumes logged-in
  identity.
- **D1 vs R2 manifest authority in `gscdump.com`** — library is R2-native
  ready; gscdump.com migration from D1-LIST is a separate decision.

## Last session (2026-04-27)

- Engine adapter contract test (`packages/engine-duckdb-node/test/contract.test.ts`)
  asserts engine-duckdb-node and engine-wasm yield identical rows for the
  same builder state over fixture parquet. Surfaced + fixed a metric-cast
  divergence in `pgResolverAdapter`: `clicks` / `impressions` weren't
  wrapped in `CAST(... AS DOUBLE)`, so the wasm path returned
  `DecimalBigNum` Arrow vectors where the analytics planner returned
  numbers.
- Wired `GSCDUMP_ANALYTICS_MODE` into `examples/nuxt-dashboard/nuxt.config.ts`
  with build-time validation; consumer mode auto-resolves apiBase to
  `https://gscdump.com` (override via `GSCDUMP_ANALYTICS_API_BASE`).
  Layout sidebar now exposes the active mode via
  `[data-testid=analytics-mode]` for smoke-test pinning.
- `tests/example-modes.test.ts` exercises the example config under every
  layer mode (local, origin, consumer + override + invalid + default).
- `tests/layer-file-count.test.ts` enforces a 90-file budget on
  `@gscdump/nuxt-analytics`; currently at 74 — flags inadvertent layer
  growth.
- Released `@gscdump/*@0.5.0` (analysis, engine + adapters,
  nuxt-analytics, gscdump, cli, mcp). gscdump.com now has a real npm
  source to pull from instead of `link:`.

## Next action

`@gscdump/*@0.5.0` shipped 2026-04-27 (analysis, engine, engine-wasm,
engine-duckdb-node, engine-sqlite, nuxt-analytics, gscdump, cli, mcp).
Phase 0 audit fixes on `gscdump.com` are the unblock for P1.1; once
green, swap `link:` → `^0.5.0` and start the file-deduplication pass.
