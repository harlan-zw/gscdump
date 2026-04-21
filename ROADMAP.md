# Roadmap

Last updated: 2026-04-16 (pre-publish prep complete; ready to ship)

## Where we are

Four packages:

- **`gscdump`** — REST client + query builder + DuckDB/parquet pipeline. Edge-compatible.
- **`@gscdump/analysis`** — analyzers + insight runners + drizzle schemas. Subpaths: `/browser`, `/sqlite`, `/window`, `/duckdb`.
- **`@gscdump/cli`** — CLI only.
- **`@gscdump/mcp`**, **`@gscdump/cloud`** — frozen.

## Audit: done

### Core pipeline (original pivot Phase 2 + 3)

- Cross-process locking (`withLock`, `proper-lockfile`).
- Sync state machine: `pending | inflight | done | failed`. Idempotent resume.
- Sync pagination via `startRow`.
- Retry with backoff (`429`, `retryAfter`).
- Sync watermark per (userId, siteId, table).
- Streaming compaction (codec-delegated).
- Per-table `schemaVersion` in manifest.
- Layer lint (`no-restricted-imports` on `node:*`).
- `sideEffects: false`, `@duckdb/duckdb-wasm` optional peer.
- Typed `GscError` union + `AbortSignal` threading.
- `queryCanonical` column exists; zero `node:*` in `core/api-client.ts`.

### gscdump.com Phase 1 (type-safe server routes)

- All 11 analysis routes + `analysis.post.ts` + `get-keywords` MCP tool on `@gscdump/engine-sqlite`.
- `METRICS_SQL` killed as public export.
- `query-resolver.ts`: 681 → 55 LoC.

### gscdump.com Phase 2 (parquet snapshot pipeline)

All migration steps done:

- `workers-duckdb.ts` uses `createHyparquetCodec` + `bindLiterals` from core.
- `parquet-writer.ts`, `parquet-reader.ts`, `r2-data-source.ts`, `gsc-metrics.ts`, `pad-timeseries.ts` deleted.
- `write-hook.ts` (166 LoC) uses `createRowAccumulator`.
- `hyparquet` + `hyparquet-writer` declared as direct deps.

### Packages — pre-publish hygiene (this pass)

- `packages/analysis/README.md` — new; documents all 6 subpaths (`/`, `/duckdb`, `/browser`, `/sqlite`, `/query`, `/window`).
- `packages/cli/README.md` — rewritten; 16 commands, 21 analyzers, stale `@gscdump/db` refs gone.
- `packages/mcp/README.md` — new; documents frozen-internal status + publishing trigger.
- `packages/gscdump/README.md` — stale `Related Packages` section fixed.
- Sync state-machine + cross-process lock tests (`sync-state.test.ts`, 7 tests).
- GC orphan sweep tests (`gc.test.ts`, 3 tests) — covers grace window, retired-entry deletion, re-check under lock.
- Resolver test regex + analysis-local test updated for current implementation.
- Full workspace suite: **388/388 passing** across 41 files.

### gscdump.com Phase 3 infrastructure (already shipped)

The browser-direct pipeline is wired end-to-end:

- **`/api/r2-data/[...path].ts`** — R2 proxy, Range/HEAD, scoped to `u_<userId>/`, immutable caching.
- **`/api/sites/[siteId]/analysis-sources.get.ts`** — D1 manifest query, dedupes daily vs monthly, returns `{tables: {[table]: URLs[]}}`.
- **`DUCKDB_SVC`** Worker service binding for the server-side fallback path (read-only via httpfs).
- **`app/composables/useBrowserAnalyzer.ts`** — WASM boot, `registerFileBuffer` + `read_parquet` views, dispatches via `analyzeInBrowser`.
- **`app/composables/useAnalyzerEngine.ts`** — top-level `engine: 'auto'` router, switches on `site.readBackend` (`'d1' | 'r2'`).
- **`/app/analysis/[tool].vue`** — already consumes the router.
- Per-user `browserAnalyzerEnabled` flag in users table.
- All 11 analyzers wired for both paths.

## Open

### 1. Publish `@gscdump/analysis` to npm

Still `link:../../pkg/gscdump/packages/analysis`. Blocks gscdump.com deploys and keeps the `SQL<unknown>` module-identity trap alive. Run `pnpm release` (root script: `bumpp --output=CHANGELOG.md packages/*/package.json`, all three packages bump together).

Pre-flight now complete:
- READMEs in place for every published / workspace package.
- `pnpm test` green (388/388).
- Typecheck + lint clean across workspace.
- Subpath exports declared in `package.json` and built by obuild.

Post-publish: update gscdump.com `package.json` to swap the `link:` for the published version.

### 2. Add `bootTimings` to `useBrowserAnalyzer`

0.5 day. Refactor the composable internals to use `createInsightRunner({ db, conn })` from `@gscdump/engine-wasm`. Exposes `{ bootMs, manifestMs, attachMs }` for a timing strip. Needed to A/B-measure before rollout. Analyzer dispatch stays on `analyzeInBrowser` — no user-facing change.

### 3. Backfill audit

For each site with `readBackend: 'r2'`, confirm parquet coverage matches D1's historical range. If sync is forward-only, old ranges still need the D1 path. Probably the biggest hidden cost of the rollout.

### 4. Rollout

- Flip `browserAnalyzerEnabled` default for new users once the timing strip validates p95 < 100 ms.
- Migrate sites to `readBackend: 'r2'` as backfill clears per-site.
- Retire D1 analytics read path after a grace period (server analysis routes become dead code).

### 5. Optional polish

- Use `resolveWindow()` to replace inline date math in analyzer params.
- Drizzle-typed custom queries via `createInsightRunner.db.select()...`. Valuable if custom-query surface expands; not required.

**Evaluated and deferred:**

- **Sync-loop retry with jitter.** The core client already retries `[408, 409, 425, 429, 500, 502, 503, 504]` at the ofetch layer (3 attempts, linear backoff). Adding a sync-loop retry on top would double-attempt and waste quota. Failed dates are caught by the idempotent-resume path (`state = 'failed'` → picked up on next cron run). Linear-vs-jittered backoff is an ofetch config tweak if thundering-herd across many sites becomes a real problem.
- **`size-limit` regression gate.** Manual sizes documented in the READMEs (core ~40 MB saved via optional peer; `/browser` 10.3 kB gz 2.72; `/sqlite` 5.3 kB gz 1.4; hyparquet adapter 4.5 kB gz 971 B). Defer CI gate until there's a specific regression to guard against.

### 6. Phase 5 — D1 ManifestStore factory (deferred)

`createD1ManifestStore(db, { manifest, watermarks, syncStates, locks })` shipped as `gscdump/analytics/d1`. Collapses gscdump.com's 326-LoC impl to a factory call. Pulls drizzle into core as optional peer. Defer until a second consumer appears.

## Open questions

1. **Dialect split.** Two subpaths (`/browser`, `/sqlite`) vs. factory. Revisit at a third target.
2. **Row-based analyzers.** Keep as parallel API for non-DuckDB consumers.
3. **Benchmark budget.** Demo: ~30 ms / insight @ 1 M rows. Dashboard SLO < 100 ms p95. Materialize nightly into D1 for any insight that breaks that.

## Recommended next action

1. Publish `@gscdump/analysis` to npm.
2. Add `bootTimings` to `useBrowserAnalyzer`.
3. Audit backfill coverage before flipping the rollout switch.
