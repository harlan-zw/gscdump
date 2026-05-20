# Roadmap

Last updated: 2026-04-29

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
- **`@gscdump/nuxt`** — Nuxt layer (`extends`). Source provider seam,
  capability gates, design-system components (`GscHero`, `DataList`,
  `QueryLabel`, `CommandPalette`, `PerformanceChart`, `Ui*`), entity routes.
- **`@gscdump/cli`** — CLI + MCP server.
- **`@gscdump/mcp`** — frozen.

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

1. **Phase 3: migrate `gscdump.com` to consume `@gscdump/nuxt`** —
   DONE. `gscdump.com` catalog pins all `@gscdump/*` to `^0.7.5` with no
   `link:` overrides; session auth provider + origin-mode config wired.
2. **Phase 5: onboard `nuxtseo.com` as consumer-mode adopter** — catalog
   bumped to `@gscdump/*@^0.7.5` and `link:` overrides dropped
   (2026-04-29). Architecture: nuxtseo.com becomes a thin consumer
   hitting gscdump.com endpoints via the layer's `apiBase` routing; only
   non-GSC composition (Lighthouse/CWV/AI briefs) stays in nuxtseo.
   Auth endpoint `/api/pro/me/gscdump-credentials` already exists.
   Still open:
   - delete `useProGscdump.ts` (1029 LOC) + refactor 44 call sites
   - drop `@gscdump/engine` / `@gscdump/analysis` from package.json
   - snapshot-test pro dashboard pages (`@nuxt/test-utils`)

### P2 — layer widening (unblocks P1.2)

Cold swap from `useProGscdump.ts` to layer composables would regress 7
user-facing features. Widen the layer first; assumes all consumers use
`@nuxt/ui` and the same layer.

1. **L1 — calendar + custom periods in `useGscPeriod`** — DONE
   (2026-04-29). Added `RollingPeriod | CalendarPeriod | CustomPeriod`
   union; new presets `this-week`, `this-month`, `last-month`,
   `this-quarter`, `this-year`; `custom:start:end` and
   `custom:start:end:prevStart:prevEnd` parsing. Helpers:
   `isCustomPeriod`, `parseCustomPeriod`, `periodToDays`, `compareRange`.
   `periodToDateRange(period, opts)` signature changed (positional
   `stableData` → options object). Timezone via
   `runtimeConfig.public.analytics.timezone` (env
   `GSCDUMP_ANALYTICS_TIMEZONE`).
2. **L2 — `useGscTableState`** — DONE (2026-04-29). `q`/`page`/
   `pageSize`/`sort`/`filter` refs with URL-sync via `useRoute` +
   `useRouter` (avoids `@vueuse/router` dep). Generic over row shape;
   prefix option for multi-table pages; `toggleSort(column)` cycles
   desc → asc → off; auto page-reset on q/filter change.
3. **L3 — indexing wrappers** — DONE (2026-04-29).
   `useGscIndexingDiagnostics`, `useGscIndexingUrls`,
   `useGscSitemapChanges`. All call `/api/__gsc/sites/[siteId]/...`;
   gscdump.com has 3 new alias handlers under `server/api/__gsc/sites/
   [siteId]/{indexing/diagnostics,indexing/urls,sitemaps/changes}.get.ts`
   that re-export the existing `/api/sites/[siteId]/...` handlers.
   Pattern matches the prior `backfill` alias.

   **Shape gap closed (2026-04-29)** — added 5 entity-store-shaped
   adapters on gscdump.com:
   - `__gsc/sites/[siteId]/sitemaps.get.ts` → `SitemapIndex` (maps
     `gsc_sitemaps` rows, keyed by `hashUrl(path)`).
   - `__gsc/sites/[siteId]/sitemaps/[hash].get.ts` →
     `SitemapHistoryResponse` from `sitemap_daily_stats`; falls back to
     a single-element snapshot when no daily history exists yet.
   - `__gsc/sites/[siteId]/inspections.get.ts` → `InspectionIndex` from
     `url_indexing_status`. Capped at 5k rows; pagination needs go via
     `/indexing/urls`.
   - `__gsc/sites/[siteId]/inspections/[hash].get.ts` →
     `InspectionHistoryResponse`. Returns `[latest]` since the schema
     keeps only latest-per-URL; scans up to 50k rows for hash → URL
     lookup. Add a hash column when very large sites surface.
   - `__gsc/whoami.get.ts` → `WhoamiResponse` with `siteIds` and
     `identityAttrs.plan`.

   **Still deferred:** `useGscRowQuery` (`/api/__gsc/sites/[id]/rows`).
   Re-pointing isn't a one-liner — gscdump.com's `/api/sites/[id]/query.post`
   is a GSC live-API proxy taking `{ startDate, endDate, dimensions, … }`,
   not a `BuilderState` translator. To support row queries in consumer
   mode either (a) add a `BuilderState` → SQL translator under `__gsc/rows`
   on gscdump.com, or (b) change the layer composable to send the simpler
   shape (breaks entity-store-mode hosts). Defer until a real consumer
   needs it.
4. **L4 — toast integration in `gsc-fetch` error path** — DONE
   (2026-04-29). `onResponseError` classifies via `classifyGscError`,
   emits `useToast()` from `@nuxt/ui`. 5s dedup keyed on
   `status:code:message`. Opt-in via
   `runtimeConfig.public.analytics.toastErrors` (env
   `GSCDUMP_ANALYTICS_TOAST_ERRORS=true`).
5. **L5 — broader `classifyError`** — DONE (2026-04-29). Extracted to
   `app/utils/gsc-error.ts` as `classifyGscError`; added `network`
   status (no statusCode + non-abort), `code` and `message` extraction
   (server `data.message` / `data.error` / native `message`). New
   `network` value added to `GscQueryStatus`.
6. **L6 — global engine override** — DONE (2026-04-29). Replaces
   `useProBrowserAnalyzerFlag()`. Two layers of override:
   `runtimeConfig.public.analytics.defaultEngine` (env
   `GSCDUMP_ANALYTICS_DEFAULT_ENGINE`, build-time) and `useGscEngine()`
   composable backed by `useState` (runtime). `useGscQuery` resolves
   `opts.engine ?? useGscEngine().value ?? cfg.defaultEngine ?? 'auto'`.
7. **L7 — filter operator re-exports** — DONE (2026-04-29).
   `app/utils/gsc-filters.ts` re-exports `and`, `or`, `between`, `eq`,
   `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `regex`, `notRegex`,
   `inArray`, `like`, `not`, `topLevel` from `gscdump/query`.
   Auto-imported via Nuxt's `app/utils/*` convention. Replaces
   nuxtseo's wire-format `dateFilter`/`andFilter` (both shapes coerce
   server-side, typed primitives are strictly better).

### P3 — polish

1. **Playwright smoke on example** — DONE (downscoped to SSR smoke).
   `tests/e2e/example-modes-render.test.ts` boots the example via
   `@nuxt/test-utils`, bounces the server per mode with
   `NUXT_PUBLIC_ANALYTICS_MODE`, and asserts the rendered
   `[data-testid=analytics-mode]` block. Build runs once, ~26s for all
   3 modes. Run via `pnpm test:e2e`.
2. **Layer page-primitive refactor** — DONE. All 11 site pages now use
   `GscDashboardPage` + `GscPageHeader`. Added `#icon` slot to
   `GscPageHeader` to support the favicon-as-title-icon on overview.
3. **Ongoing policy**: every layer change updates example in same PR;
   breaking = major bump; shared telemetry. No 1.0 cut planned for now —
   `0.7.x` is the working line.

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
  `@gscdump/nuxt`; currently at 74 — flags inadvertent layer
  growth.
- Released `@gscdump/*@0.5.0` (analysis, engine + adapters,
  nuxt, gscdump, cli, mcp). gscdump.com now has a real npm
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

## Last session (2026-04-29)

- Confirmed `gscdump.com` is fully on `@gscdump/*@^0.7.5` via catalog with
  no `link:` overrides — P1.1 Phase 3 adoption DONE.
- Bumped `nuxtseo.com` catalog to `@gscdump/*@^0.7.5` and dropped the
  three `link:` overrides on `analysis`, `engine-duckdb-wasm`,
  `@gscdump/nuxt`. Needs `pnpm install` in the `nuxtseo.com` repo to
  resolve. Layer auth provider + `useProGscdump*` deletion still open
  under P1.2.
- Dropped P2 1.0 cut from the plan — `0.7.x` is the working line for now.
- Engine cleanup pass — kill dead code, push driver-specific adapters
  into their drivers. Cross-checked against `gscdump.com` and
  `nuxtseo.com` to confirm zero production callers before deleting.
  - Deleted `engine/adapters/http.ts` (~176 LOC, zero references).
  - Deleted the SQLite-backed `InspectionStore`:
    `engine/adapters/inspection-sqlite-{node,browser}.ts` plus
    `createInspectionStoreSqlite`, `inspectionSqliteKey`,
    `InspectionSqlDriver`, `CreateInspectionStoreSqliteOptions` from
    `entities.ts` (~233 LOC). JSON-backed `createInspectionStore` is
    what cli + @gscdump/nuxt actually use; the SQLite track had no
    consumers.
  - Dropped `engine` peer deps `better-sqlite3` + `wa-sqlite` and the
    matching catalog entries / `onlyBuiltDependencies` slot.
  - Dropped 4 dead subpath exports from `engine`: `/http`,
    `/inspection-sqlite-node`, `/inspection-sqlite-browser`,
    `/node-harness`.
  - Moved `node-harness.ts` → `@gscdump/engine-duckdb-node`.
    `createNodeHarness` is the Node-side turnkey primitive (filesystem
    DataSource + DuckDB executor + manifest store in one call); native
    home is the Node driver, not the dialect-neutral engine. cli imports
    swapped (`@gscdump/engine/node-harness` → `@gscdump/engine-duckdb-node`).
  - Net: ~924 lines removed across 7 deleted files; 13 packages
    typecheck; engine 222/222 tests, cli 102/102 tests; lint clean.

## Next action

1. Run `pnpm install` in `nuxtseo.com` to resolve the new catalog ranges,
   then continue P1.2: layer auth provider for pro-user GSC credentials,
   delete `useProGscdump*` composables, snapshot-test pro dashboard
   pages.
2. **Bundle-size audit**: `analyzeInBrowser` lives in `@gscdump/analysis`,
   so the analysis bundle pulls in every SQL analyzer's SQL strings even
   for row-only consumers. Check whether the `/analyzer` (rows only)
   subpath can stay slim.
3. Refresh stale analyzer-plan snapshots if the SQL drift is intended.
4. Continued driver-primitive expansion (mirror the wasm shape):
   `engine-sqlite` could gain D1+R2 wiring helpers; `engine-gsc-api`
   could gain request batching / range planning so callers don't compose
   `rollup-synth` + `post-process` manually.
