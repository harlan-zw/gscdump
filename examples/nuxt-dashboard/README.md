# nuxt-dashboard — Phase 3 reference

A Nuxt 4 dashboard that runs every analyzer both ways:

- **Browser · flag on** — DuckDB-WASM in the browser queries Parquet shards on R2 directly via presigned URLs. First request pays the WASM + manifest + attach cost (~300–600 ms cold); every subsequent tab is just the query (~20–80 ms warm).
- **Server · flag off** — Nitro server route runs the same analyzer against a Node DuckDB process that reads from R2 over HTTPS. Represents the "current state" before migration.

Flip the toggle, click through the seven analyzer tabs, watch the timing strip update. That's it — this is the Phase 3 A/B harness.

## Architecture

```
client                                        server
──────                                        ──────
pages/index.vue                               api/manifest.get.ts      ─┐
  └─ useInsightRunner()                       api/sign-url.get.ts      ─┤ R2 S3 creds
       ├─ @gscdump/analysis/browser           api/analysis/[x].get.ts  ─┘
       ├─ @gscdump/analysis/duckdb              └─ utils/analysis-engine.ts
       └─ DuckDB-WASM (worker)                      ├─ gscdump/analytics/node
                                                    ├─ gscdump/analytics/http
                                                    └─ gscdump/analytics (engine)
                ▲
                └──── $fetch('/api/sign-url') + R2 presigned GETs
```

Every piece except the Vue components is a production primitive from this monorepo. The composable is ~120 LoC; gscdump.com can copy it into its `app/composables/` directory unchanged.

## Which primitives does this exercise?

| File | Primitive used | Where it lives |
|---|---|---|
| `server/api/manifest.get.ts` | `aws4fetch` R2 LIST | local helper |
| `server/api/sign-url.get.ts` | `aws4fetch` SigV4 presign | local helper |
| `server/utils/r2-client.ts` | R2 LIST + presign | local helper |
| `server/utils/analysis-engine.ts` | `createStorageEngine` + `createDuckDBCodec` + `createDuckDBExecutor` + `createHttpDataSource` + `createHttpManifestStore` + `createNodeDuckDBHandle` | `gscdump/analytics`, `gscdump/analytics/http`, `gscdump/analytics/node` |
| `server/api/analysis/[analyzer].get.ts` | `analyzeWithDuckDB` | `@gscdump/analysis/duckdb` |
| `app/composables/useInsightRunner.ts` | `attachParquetIndex` + `analyzeInBrowser` + `bindLiterals` | `@gscdump/analysis/duckdb`, `gscdump/analytics` |
| `app/pages/index.vue` | orchestration only | — |

## Setup

1. Copy `.env.example` → `.env` and fill in R2 credentials:

   ```sh
   cp .env.example .env
   $EDITOR .env
   ```

   You need an R2 S3 API token (not a `wrangler` binding) — the Nitro server calls R2 directly via `aws4fetch`. Generate one in the Cloudflare dashboard under **R2 → Manage R2 API Tokens**.

2. Install + run:

   ```sh
   pnpm install             # from the repo root
   pnpm --filter @gscdump/example-nuxt-dashboard dev
   ```

3. Open `http://localhost:3000`. First tab is the cold path; switch tabs or toggle modes to see warm numbers.

## Reading the timing strip

```
● browser   boot 420 ms   manifest 81 ms   attach 62 ms   query 28 ms
● server    server setup 12 ms   server query 145 ms   round-trip 198 ms
```

- **boot**: one-time DuckDB-WASM init (worker + module instantiate). Cached across tab switches.
- **manifest**: one-time `/api/manifest` fetch. Cached.
- **attach**: one-time `CREATE VIEW … FROM read_parquet([…])` per table. Cached.
- **query**: per-tab insight run. Comparable to server query time, minus round-trip.
- **server setup**: Node DuckDB lazy-init + engine + manifest cache on the server. Amortises to ~0 after first request.
- **server query**: SQL execution on the Node process.
- **round-trip**: end-to-end from the browser's perspective. Includes network.

Cold-boot-plus-first-query on the browser path typically beats the server round-trip after the second tab — because browser DuckDB sits on a warm connection while server DuckDB re-initialises per isolate on deploys.

## Deploying

Works on anything Nuxt deploys to that supports Node:

- **Node dev / node-server preset** — out of the box.
- **CF Pages / CF Workers** — the server analysis route needs a DuckDB shape that runs on Workers. Swap `gscdump/analytics/node` for a service-binding-backed executor (see gscdump.com's `workers-duckdb.ts` for the pattern).
- **Static deploys** — skip the server routes, host the manifest JSON as a static file, run browser-only. Same composable, just don't wire the fallback.

## Relation to `browser-http`

- `examples/browser-http` — research harness. Five different attach strategies side by side (snapshot, snapshot-url, hotcold, parquet-views, http), pick-your-own. Vanilla HTML, no Nuxt.
- `examples/nuxt-dashboard` (this) — product shape. One strategy (parquet-views), one UI, one A/B flag. What you'd actually ship.

## What this doesn't cover

- Per-user auth on the sign-url route — `.env.GSCDUMP_USER_ID` is pinned for the demo. In gscdump.com you'd read the session here.
- Rate limiting or signed-URL TTL rotation — skip for a demo.
- Error reporting beyond an on-screen `{{ error.message }}` — no Sentry, no logs.
- The D1 manifest path — here the server builds the manifest from an R2 LIST. gscdump.com reads it from D1's `r2_manifest` table.

The dashboard is a minimum viable Phase 3 proof: all seven analyzers, both modes, honest numbers.
