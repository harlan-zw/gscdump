# Roadmap

Last updated: 2026-05-25

Only open work lives here. Completed extraction/research plans have been
removed from the root docs; shipped work belongs in git history, release notes,
and package tests.

## Completion Bar

For planning purposes, **complete means implemented and covered by passing
e2e**. The local e2e suite passes, but live Google API coverage still skips
without BYOK credentials:

```bash
pnpm test:e2e
# Last BYOK run: 10 passed | 1 skipped
```

Before marking live API work complete, run the same command with either
`GSC_ACCESS_TOKEN` or `GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` +
`GSC_REFRESH_TOKEN`.

## Current State

Working line: **`0.22.x`**.

Current package set:

- `gscdump`
- `@gscdump/engine`, `@gscdump/engine-duckdb-wasm`,
  `@gscdump/engine-sqlite`, `@gscdump/engine-gsc-api`
- `@gscdump/analysis`
- `@gscdump/contracts`
- `@gscdump/sdk`
- `@gscdump/cloudflare`
- `@gscdump/nuxt`
- `@gscdump/cli`
- `@gscdump/mcp` (frozen)

Local verification already covers:

- `@gscdump/contracts` owns `analyticsRoutes` and analytics response schemas.
- `@gscdump/sdk` exposes `createAnalyticsClient`, `createPartnerClient`,
  `createGscdumpClient`, and `./query`.
- `@gscdump/nuxt` uses the SDK analytics client internally.
- Hourly Discover primitives exist across query builder, GSC API sync slice,
  engine storage, rollups, GC, and tests.
- Local e2e renders the Nuxt example in all advertised modes.

## Open Work

### P0 — Live API e2e verification — CLOSED

The real Google API e2e suites pass with BYOK credentials:

- `tests/e2e/sites-real.test.ts`
- `tests/e2e/pipeline-real.test.ts`

These cover the live site/verification surface and the full
GSC API -> `runGscSyncSlice` -> parquet write -> DuckDB query round trip.
Last BYOK run: `3 passed` test files, `10 passed | 1 skipped` tests.

### P1 — Consumer adoption: `nuxtseo.com`

This is external to this repo and is tracked in
`/home/harlan/sites/nuxtseo.com/docs/gscdump-consumer-adoption.md`.

Closes when: the consumer doc's closeout criteria are met, including no stale
`@gscdump/nuxt-analytics` references, no duplicated hosted API contract types
for gscdump endpoints, relevant pro dashboard tests passing, and any remaining
direct engine imports documented as deliberate.

### P2 — Library follow-ups — CLOSED

- **`useGscRowQuery` in consumer mode** — decision recorded in
  `docs/adr/0010-consumer-row-query-uses-builderstate.md`: keep
  `BuilderState` as the wire contract and translate it against the host's
  DuckDB/Iceberg table layer.
- **Bundle-size audit** — closed by making `@gscdump/nuxt` load
  `@gscdump/analysis/registry` lazily only when the browser-attached analyzer
  path runs. Row-only/server consumers no longer get a static full-registry
  import through `useGscQuery`.

Verification: `pnpm --filter @gscdump/nuxt typecheck`, `pnpm test:contracts`,
and BYOK `pnpm test:e2e` pass.

### P3 — Hosted strategy docs — CLOSED

Hosted strategy is documented in
`docs/adr/0011-hosted-gscdump-strategy.md`.

The ADR covers partner API versus analytics `/api/__gsc/*` API, SDK stability,
Cloudflare/R2 SQL boundaries, report/example ownership, and which behavior
belongs in host apps versus `@gscdump/nuxt`.

## Risks To Monitor

- **R2 1-write/sec/key cap on `manifest/HEAD`** — use per-`searchType` sharding
  if conditional rejections climb. Run the contention harness against a real
  R2 bucket before production rollout.
- **`union_by_name = true` masking schema drift** — read path silently fills
  missing columns with NULL; relies on `schemaVersion` checks.
- **GSC API quota on free-tier fanout** — 1200 QPM/site shared.
- **Tier cookie is client-controlled** — production hosts must derive tier
  from billing or account state.
- **Inspection store growth** — prune old rows if storage grows too quickly.

## Non-Goals

- **Bloom filters** — hyparquet-writer does not support them.
- **Opt-in slice tables** (`keywords_country`, `pages_country`) — rollups
  answer most cross-cuts.
- **Mega fact-table consolidation** — GSC's per-dimension aggregation lossiness
  makes a single all-dimensions fact table silently incorrect.
- **DataForSEO / Lighthouse / CrUX / AI features in the layer** — stay in
  consumer apps.
- **Feature-flag scaffolding in the layer** — features ship or do not.
- **Billing / licensing in the layer** — assumes logged-in identity supplied by
  the host.

## Next Action

1. Continue consumer-side closeout in
   `/home/harlan/sites/nuxtseo.com/docs/gscdump-consumer-adoption.md`.
2. Keep this roadmap open only for new package-level work that has not met the
   completion bar.
