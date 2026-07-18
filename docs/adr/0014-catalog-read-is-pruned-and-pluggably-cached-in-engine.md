# 0014. The catalog read path is pruned and pluggably cached in the engine

- Status: accepted
- Date: 2026-06-18
- Supersedes the consumer's hand-rolled `iceberg-manifest-prune.ts` resolver.

## Context

R2 Data Catalog read latency was traced to the shared, multi-tenant `gsc.<table>`
fact tables. Two structural problems, plus a divergence that hid them:

1. **O(all tenants) reads.** `listIcebergDataFiles` fetched EVERY manifest in the
   current snapshot and filtered to one site in JS. Every site's parquet files
   live under one manifest set, so resolving one site fanned out across the whole
   catalog.
2. **A `loadTable` round-trip on every cold isolate.** The resolved file list was
   cached, but the cache key needs the snapshot id, which only `restCatalogLoadTable`
   returns — so even a guaranteed cache hit still paid one catalog round-trip per
   table (up to 9), and table metadata was never cached cross-isolate.
3. **Two implementations of one read path.** The engine shipped an unpruned,
   uncached `listIcebergDataFiles`; the consumer (`gscdump.com`) had reimplemented
   a pruned + KV-cached copy (`iceberg-manifest-prune.ts`) and carried a *divergent*
   `icebird` patch (same filename, extra `partitionFilter` hunk) the engine lacked.

## Decision

The engine owns the pruned + cached catalog read; the consumer converges onto it.

- **Manifest-list pruning lives in the engine** (`partition-prune.ts`). The patched
  `icebergManifests({ partitionFilter })` skips a manifest whose manifest-list
  `partitions` summaries prove it cannot hold the target `(site_id, month)` slice,
  BEFORE fetching its entries. This is an inclusive projection: it never drops a
  matching file, only avoids reading non-matching manifests. The entry-level filter
  remains the authoritative correctness check.

- **Caching is a pluggable `unstorage` `Storage`** (`catalog-cache.ts`,
  `CatalogCache`). The engine never constructs storage — the caller injects a driver
  (Cloudflare KV in prod, memory/LRU in tests). `unstorage` is a **type-only** import,
  so the edge-safe core gains no runtime storage dependency (verified: zero `.mjs`
  bundle reference). Two caches:
  - `gsc-snapref` `(namespace, table) → snapshotId`, short TTL (30s). A warm pointer
    skips `loadTable`; a miss costs one round-trip, never a stale read.
  - `gsc-files` `(namespace, table, snapshotId, site, searchType, months) → file[]`,
    long TTL (24h). Content-addressed by the immutable snapshot id, so a hit is always
    correct within its lifetime and skips the manifest walk entirely.
  Cache writes route through an optional `defer` hook (e.g. `ctx.waitUntil`) so they
  leave the response critical path; without one they are awaited so a put is never
  cut off.

- **The `icebird` patch is unified.** This repo adopts the consumer's remaining patch
  (`partitionFilter` + REST commit-body BigInt serialization + the snapshot sentinel
  fix) as the single source of truth. Both repos now carry an identical
  `patches/icebird@0.8.12.patch`.

## Consequences

- `listIcebergDataFiles` keeps its name and adds optional `cache` / `clock`. It now
  prunes unconditionally and caches when a `cache` is supplied — no new export surface
  beyond `CatalogCache`.
- The consumer (`gscdump.com`) deletes `iceberg-manifest-prune.ts` and its divergent
  patch, routing every call site through the engine resolver with a CF-KV `unstorage`
  driver + `event.waitUntil`. That removes the divergence and extends the cross-isolate
  cache to the paths that previously skipped it (`cross-source`, `historical-depth`,
  `discover-hourly`). Ships after an engine release + catalog bump.
- Manifest-fetch count becomes independent of tenant count; a warm catalog serves a
  cold isolate with zero catalog round-trips and zero manifest fetches.
- `connectIcebergCatalog` takes the same `cache` and skips the `/v1/config` probe on a
  warm catalog. Only the warehouse-static routing config (`url`, `prefix`, `defaults`,
  `overrides`) is cached and the bearer is rebuilt from config, so no secret enters the
  cache. icebird reads only `url`/`prefix`/`requestInit` downstream, so the rebuilt
  context is faithful with no icebird patch needed.
- `@gscdump/cloudflare`'s unused `createR2Presigner` / `PresignOptions` are deleted (the
  consumer reimplemented presigning as `presignR2GetUrl`); `createInflightDedupe` stays
  (used by the R2-SQL gateway).
- Follow-up (Phase 2): bundle the patched `icebird` into the engine dist and route all of
  `gscdump.com` through the engine's iceberg wrappers, so the consumer drops the `icebird`
  dependency and its patch entirely. The build is pre-wired for this (the `hysnappy`
  alias in `build.config.ts` keeps an inlined `icebird` Worker-safe). An upstream PR to
  Hyperparam for `partitionFilter` would let the patch retire.
