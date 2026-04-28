# Roadmap

Last updated: 2026-04-28

Unified successor to `PIVOT.md`, `NEXT_STEPS.md`, `NEXT_STEPS-example.md`,
`PORTING_PLAN.md`, `EXTRACTION_PLAN.md`. Only open work lives here; shipped
items are recorded in git history.

## Where we are

Eleven packages:

- **`gscdump`** — REST client + query builder. Edge-compatible.
- **`@gscdump/engine`** — parquet/R2 storage + tiered compaction + R2 manifest
  CAS + rollups + entity stores + tenant-scoped GDPR purge. Now also owns the
  contract layer: `Analyzer` interface, `defineAnalyzer`, dispatcher, registry,
  `AnalysisParams`/`AnalysisResult`, period helpers, `createEngineQuerySource`.
- **`@gscdump/engine-duckdb-wasm`**, **`@gscdump/engine-sqlite`**,
  **`@gscdump/engine-duckdb-node`** — engine adapters (parquet/R2 backends).
- **`@gscdump/engine-gsc-api`** — GSC live-API engine adapter.
- **`@gscdump/analysis`** — analyzer instances (row + sql), composite source,
  attached-table dispatcher, semantic analyzers. Re-exports the contract layer
  from `@gscdump/engine` for ergonomics.
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

4. **Playwright smoke on example** — DONE (downscoped to SSR smoke).
   `tests/e2e/example-modes-render.test.ts` boots the example via
   `@nuxt/test-utils`, bounces the server per mode with
   `NUXT_PUBLIC_ANALYTICS_MODE`, and asserts the rendered
   `[data-testid=analytics-mode]` block. Build runs once, ~26s for all
   3 modes. Run via `pnpm test:e2e`.
5. **Layer page-primitive refactor** — DONE. All 11 site pages now use
   `GscDashboardPage` + `GscPageHeader`. Added `#icon` slot to
   `GscPageHeader` to support the favicon-as-title-icon on overview.
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
  asserts engine-duckdb-node and engine-duckdb-wasm yield identical rows for the
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

## Last session (2026-04-27 afternoon)

- P3.5 page-primitive refactor: shipped `GscDashboardPage` +
  `GscPageHeader` across the last 6 inline-markup pages (overview,
  analyze, pages list/detail, queries list/detail). Layer now has a
  consistent shell on all 11 site pages.
- `GscPageHeader` gained an `#icon` slot so the overview page can render
  `GscFavicon` (domain favicon) in place of a static lucide icon while
  keeping the `icon` prop fallback for the other pages.
- P3.4 Playwright smoke: downscoped to an SSR smoke under
  `@nuxt/test-utils`. Added `tests/e2e/vitest.config.ts` (root-scoped
  to `tests/e2e/`) and `tests/e2e/example-modes-render.test.ts`. Build
  runs once; server bounces per mode via `NUXT_PUBLIC_ANALYTICS_MODE`,
  asserting the layout's `[data-testid=analytics-mode]` block surfaces
  the active mode. Wired `pnpm test:e2e`. ~26s wall clock.
- Fixed a real chunk-splitting bug surfaced by the smoke build: the
  layer's `useGscPeriod` composable referenced `GSC_STABLE_LATENCY_DAYS`
  via auto-import only, and Vite's chunk splitter dropped the constant
  from `GscDateRangePicker`'s SSR chunk (the constant was inlined into
  a sibling chunk instead). Added an explicit `import` in
  `useGscPeriod.ts`. Without this, any SSR render of `/` 500'd with
  `GSC_STABLE_LATENCY_DAYS is not defined`.
- Typecheck clean; `tests/layer-file-count.test.ts` and
  `tests/example-modes.test.ts` still pass. Pre-existing snapshot drift
  in `packages/analysis/test/analyzer-plan-snapshots.test.ts` (SQL
  whitespace in CTR shortfall plans) is unchanged by this work.

## Last session (2026-04-28)

- Phase 4 of the package-scope refactor: extracted `@gscdump/engine-gsc-api`
  from `@gscdump/analysis/source/{gsc,live,gsc-rollup-synth,post-process}`.
  GSC live-API now sits behind a real package boundary alongside the other
  three engine adapters.
- Broke the analysis ↔ engine-adapter cycle that was blocking the Phase 4
  extract. Lifted the contract layer to `@gscdump/engine`: `Analyzer`,
  `Plan`, `Capability`, `defineAnalyzer`, `runAnalyzerFromSource`,
  `createAnalyzerRegistry` under `/analyzer`; `AnalysisParams` /
  `AnalysisResult` / `AnalysisTool` under `/analysis-types`; period
  primitives under `/period`; `createEngineQuerySource` +
  `runAnalyzerWithEngine` + `typedQuery`/`queryRows` under `/source`.
  Moved `SQL_ANALYZERS` and `analyzeInBrowser` from `@gscdump/engine-duckdb-node`
  into `@gscdump/analysis` (they reference analyzer instances and don't
  belong on the engine boundary). Dropped `analysis/source/{browser,sqlite,
  engine,types}.ts` re-export shims; consumers import directly from the
  engine packages they need.
- Killed the legacy `AnalyzerSpec` / `registry-compat` / `analyzer-runtime`
  bridge inside `analyzeInBrowser` (~250 lines). Replaced with a thin
  `createAttachedTableSource(runner, { schema })` factory that wraps the
  runner in an `AnalysisQuerySource` with the `attachedTables` capability
  and lets `runAnalyzerFromSource` do the dispatch. `analyzeInBrowser` is
  now ~10 lines over the unified pipeline; analyzer-parity tests still
  pass byte-for-byte.
- pnpm cyclic-deps warning gone. 13 packages typecheck, 635 tests pass.
  gscdump.com lockstep updated (`seam.ts` imports `createEngineQuerySource`
  from `@gscdump/engine/source`, `createLiveGscSource` from
  `@gscdump/engine-gsc-api`); workspace catalog + override added for
  `engine-gsc-api`. nuxtseo.com untouched (declares `@gscdump/analysis` but
  no source-level imports).

## Next action

The 5-phase package-scope refactor is done. Open levers:

1. P1.1 (`gscdump.com` Phase 3 adoption) is still the biggest consumer
   move once Phase 0 audit fixes land — swap `link:` → `^0.7.x` once the
   refactor is published and start the file-deduplication pass.
2. Bundle-size audit: now that `analyzeInBrowser` lives in `@gscdump/analysis`,
   the analysis bundle pulls in every SQL analyzer's SQL strings even for
   row-only consumers. Worth checking whether the `/analyzer` (rows only)
   subpath can stay slim.
3. Refresh stale analyzer-plan snapshots if the SQL drift is intended.
