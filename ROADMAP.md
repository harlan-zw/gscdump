# Roadmap

Last updated: 2026-05-20

Only open work lives here; shipped items are recorded in git history. The
prior revision of this file had drifted ~11 minor versions out of date
(claimed `0.7.x`, eleven packages, `engine-duckdb-node` extant); it was
rewritten against the codebase on 2026-05-20.

## Where we are

Working line: **`0.18.x`** (`@gscdump/nuxt` is one ahead at `0.18.7`).

Thirteen packages:

- **`gscdump`** — REST client + typed query builder. Edge-compatible.
- **`@gscdump/engine`** — parquet/R2 storage, tiered compaction, R2 manifest
  CAS, rollups, entity stores, tenant-scoped GDPR purge. Owns the contract
  layer: `Analyzer` interface, `defineAnalyzer`, dispatcher, registry,
  `AnalysisParams`/`AnalysisResult`, period helpers, `createEngineQuerySource`.
  `searchType` is threaded end-to-end (manifest reads, rollup builders, raw
  SQL, JSON rollup key namespacing).
- **`@gscdump/engine-duckdb-wasm`**, **`@gscdump/engine-sqlite`** — engine
  adapters (parquet/R2 backends). `engine-duckdb-node` was removed;
  `createNodeHarness` now lives elsewhere — verify its current home.
- **`@gscdump/engine-gsc-api`** — GSC live-API engine adapter.
- **`@gscdump/analysis`** — analyzer instances (row + sql), composite source,
  attached-table dispatcher, semantic analyzers.
- **`@gscdump/contracts`** — shared gscdump.com API, webhook, realtime, and
  lifecycle contracts (`onboarding`, `routes`, `schemas`, `webhook-constants`).
- **`@gscdump/sdk`** — consumer SDK for hosted gscdump.com integrations
  (`analytics-client`, `client`, `realtime`, `webhook`, `lifecycle`, `query`).
  Subpath exports: `.`, `./query`.
- **`@gscdump/cloudflare`** — Cloudflare-Workers helpers: `AnalyticsEnv`
  binding contract, R2 SigV4 presigner, size-hint HMAC, DuckDB Workers shims,
  engine factory.
- **`@gscdump/cloud`** — cloud protocol layer (`protocol.ts`).
- **`@gscdump/nuxt`** — Nuxt layer (`extends`). Source provider seam,
  capability gates, `Gsc*` components, entity routes.
- **`@gscdump/cli`** — CLI + MCP server.
- **`@gscdump/mcp`** — frozen.

Example consumer: `examples/nuxt-dashboard` — free (GSC API) and pro
(engine/DuckDB) tiers; site pages for overview, queries, pages, countries,
indexing, sitemaps, insights, search-appearance, analyze; plus `partner`,
`report`, and `boot-demo` pages exercising cloud/partner/reporting flows.

## Recently shipped (since 2026-04-29, unreleased in old roadmap)

- **`searchType` threading** — manifest reads filtered by `searchType` to
  prevent cross-type contamination (#4), shared `parseSearchType` +
  SearchType/schema drift guard, namespaced JSON rollup keys, `--search-type`
  flag on `gscdump dump`, `searchType` through `createEngineQuerySource`.
- **R2 entity-store extensions** for sitemap + indexing degating (#3).
- **Query optimizer**: `prefilter compiler` + `queryOptimized` perf pass.
- **`reports`** feature.
- **`inspect`** feature; strict-equality indexing issue filters +
  `discovered_not_indexed`.
- **Breaking**: `@gscdump/nuxt` dropped primitive components
  (`Ui*`, `DataList`); surviving components are `Gsc`-prefixed.

## Open work

### P1 — consumer adoption: `nuxtseo.com`

`nuxtseo.com/apps/pro` depends on `@gscdump/{contracts,engine,nuxt,sdk}`
(all `catalog:`, `^0.18.5`), so the SDK-consumer route is partly wired.

> **Stale dependency name.** Both `gscdump.com` and `nuxtseo.com` still
> reference `@gscdump/nuxt-analytics`; the canonical name is `@gscdump/nuxt`.
> Update both consumer manifests + catalogs to `@gscdump/nuxt`.

**Migrate `useProGscdump` plumbing onto `@gscdump/sdk`.** The old roadmap
framed this as "delete `useProGscdump`, use the layer" — both wrong. The
`useProGscdump/` family (13 files, ~1051 LOC) is a legitimate set of Vue
reactivity wrappers over the gscdump.com **partner API** (`/api/sites/...`).
The layer (`@gscdump/nuxt`) only owns the `/api/__gsc/*` parquet/DuckDB path;
it does not cover the partner API. The correct target is `@gscdump/sdk`'s
`createGscdumpClient`, whose typed methods (`getData`, `getIndexing`,
`getSitemaps`, …) and `@gscdump/contracts` zod schemas already cover every
partner endpoint the family hits.

The work is **swap internals, keep composable signatures**, so the 65
importing files mostly don't change:

- Build a singleton `useGscdumpClient()` wrapping `createGscdumpClient`, fed
  credentials/`apiBase` from `useGscdumpIntegration()` and error mapping from
  the existing toast helper. Replaces `useProGscdump().fetchGscdump`.
- Rewire `_internal.ts` `useGscdumpQuery` and each sibling to call typed
  client methods instead of hand-rolled `fetchGscdump('/sites/...')`.
- Replace local `shared/gscdump-api` types with `@gscdump/contracts`; delete
  the duplicate.
- Rewire the ~15 files outside the directory that call `useProGscdump()` raw
  (`useDashboardSiteData.ts`, `gsc-debug.vue`, `SparklineLoader.vue`, the
  `Pro*` split components, `canonicals.vue`/`insights.vue`,
  `useIndexingPrompt.ts`).
- `useGscCoverage` is *not* part of this migration — it hits the
  `/api/__gsc/.../coverage` analytics-proxy path, not the partner API, and
  stays as-is. (Optional: add that route + a `CoverageResponse` schema to
  `analyticsRoutes` in `@gscdump/contracts` so it can drop its local type.)
- `@gscdump/engine` is still a direct `apps/pro` dependency; drop it once the
  browser-analyzer path (`useGapEngine` / `useProAnalyzeWithFallback`) no
  longer imports it directly.
- Snapshot-test the pro dashboard pages (`@nuxt/test-utils`).

### P2 — library follow-ups

- **`useGscRowQuery` in consumer mode** — still deferred. Needs either a
  `BuilderState`→SQL translator on the gscdump.com host or a simpler wire
  shape from the layer composable.
- **Bundle-size audit** — `analyzeInBrowser` lives in `@gscdump/analysis`, so
  the analysis bundle pulls every SQL analyzer's SQL strings even for
  row-only consumers. Confirm the rows-only path stays slim.
- **Analyzer-plan snapshots** — refresh if the SQL whitespace drift in
  `packages/analysis/test/analyzer-plan-snapshots.test.ts` is intended.

### P3 — strategy (needs owner input)

The cloud direction (`@gscdump/cloud`, `@gscdump/contracts`, `@gscdump/sdk`,
`@gscdump/cloudflare`, the `partner`/`report` example pages) is real but
undocumented here. Capture intent and milestones for: hosted gscdump.com as
the consumer host, the partner/reporting surface, and the SDK contract
stability bar.

## Risks to monitor

- **R2 1-write/sec/key cap on `manifest/HEAD`** — per-`searchType` sharding if
  `conditionalRejections` climbs. Run the contention harness against a real
  R2 bucket before production rollout.
- **`union_by_name = true` masking schema drift** — read path silently fills
  missing columns with NULL; relies on `schemaVersion` checks.
- **GSC API quota on free-tier fanout** — 1200 QPM/site shared.
- **Tier cookie is client-controlled** — production hosts must derive tier
  from a billing source.
- **Inspection store unbounded growth** — prune old rows if storage grows.

## Explicit non-goals

- **Bloom filters** — hyparquet-writer doesn't support them.
- **Opt-in slice tables** (`keywords_country`, `pages_country`) — rollups
  answer most cross-cuts.
- **Mega fact-table consolidation** — GSC's per-dim aggregation lossiness
  makes a single all-dimensions fact table silently incorrect.
- **DataForSEO / Lighthouse / CrUX / AI features in the layer** — stay in
  nuxtseo.com.
- **Feature-flag scaffolding in the layer** — features ship or don't.
- **Billing / licensing in the layer** — assumes logged-in identity.

## Next action

1. Rename the `@gscdump/nuxt-analytics` dependency to `@gscdump/nuxt` in the
   `gscdump.com` and `nuxtseo.com` manifests + catalogs.
2. Continue P1 (all `nuxtseo.com`-side — gscdump packages are ready): swap
   the `useProGscdump` family internals onto `@gscdump/sdk`, drop
   `@gscdump/engine` from `apps/pro`, snapshot-test pro pages.
3. Document the cloud/partner/SDK strategy under P3.
