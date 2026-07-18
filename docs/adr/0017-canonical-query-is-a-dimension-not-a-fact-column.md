# 0017. Canonical query is a dimension; variant grouping is a rollup, not a read-time window sort

- Status: proposed
- Date: 2026-06-23
- Relates to ADR-0010 (consumer row query uses BuilderState) and the
  `rollups.ts` / `compaction.ts` derived-data infrastructure.

## Context

`query_canonical` is the canonical form of a search query, produced by
`normalizeQuery` in `@gscdump/analysis` (lowercase, separators stripped,
synonyms collapsed, depluralized, tokens sorted). It exists so near-duplicate
queries (`nuxt seo`, `seo nuxt`, `nuxt-seo`, `sitemap checker` vs
`sitemap tester`) group into one row. It is a **pure deterministic function of
`query` alone**.

Today it is handled two ways, both of which recompute or re-store derived data:

1. **Stored, denormalized.** `query_canonical` is materialized as a full
   varchar on every fact row in `queries`, `page_queries`,
   `search_appearance_queries`, and `search_appearance_page_queries`
   (`drizzle-schema.ts`, written at ingest by `transformGscRow` in
   `ingest.ts`). It is baked in at ingest, so changing the synonym map or
   depluralize rules leaves all history stale until re-ingest.

2. **Recomputed at read time.** When `queryCanonical` is a grouping dimension,
   `buildExtrasQueries` (`resolver/compile.ts:503`) runs, on every request,
   over the whole `queries` table for the date range:
   - `ROW_NUMBER() OVER (PARTITION BY query_canonical ORDER BY SUM(clicks) DESC)`
   - `COUNT(*) OVER (PARTITION BY query_canonical)`
   - a `GROUP_CONCAT` of the top-10 variants

   to derive `canonicalName` (top-clicks variant), `variantCount`, and the
   variant list. These outputs change only when new rows land, yet they are
   recomputed per request, single-threaded under DuckDB-WASM / Workers.

### Validation (2M `queries` rows, one search type, `SET threads=1`)

Read-path CPU (the hot dashboard path):

| read path | wall, single thread |
| --- | --- |
| current `buildExtrasQueries` (two window passes + `group_concat`) | ~92 ms |
| join against a materialized variant rollup | ~1 ms |

Native multicore masks this (26 ms wall / 245 ms user CPU); production WASM /
Workers run single-threaded, so the user-CPU figure is the wall time, and it
scales with table size on every request.

Storage of the canonical column (sorted layout, zstd):

| layout | file size |
| --- | --- |
| string `query_canonical` per fact row (today) | 12.0 MB |
| int `query_canonical_id` per fact row | 11.6 MB (−3%) |
| no canonical column on fact rows | 9.1 MB (−24%) |

Parquet already dictionary+RLE-encodes the repeated canonical string, so
surrogate-int dictionary encoding of the fact column saves ~3% and can regress
when row order shifts. The 24% is reclaimable only by not storing canonical per
fact row at all.

## Decision

Treat `query_canonical` as derived data with two distinct representations, and
stop recomputing/denormalizing it on the hot paths.

### 1. Materialize variant grouping as a rollup (the CPU win — do first)

Add a `query_canonical_variants` rollup built through the existing `RollupDef`
infrastructure in `rollups.ts` (parquet format, `parquetSortKey` on the
canonical key), maintained at sync/compaction time. One row per canonical
group: `{ canonical, canonicalName, variantCount, variants[] }`. The read path
in `compile.ts` becomes a cheap dictionary join (`mergeExtras` already joins on
the canonical key); `buildExtrasQueries`' two window passes and `GROUP_CONCAT`
move out of the request path entirely. ~90x less read CPU at the benchmarked
size, scaling with table size.

### 2. Normalize canonical into a `query` dimension (the storage win — phase 2)

`query_canonical` is a function of `query`, so it does not belong on every fact
row. Introduce a per-site `query` dimension store mapping each distinct
`query → { canonical, canonical_id }`, written once per distinct query (an
entity/dimension store like `entities.ts`, not a per-(query×date×…) fact
column). Fact tables drop the `query_canonical` column; reads that need
canonical join through the dimension. This reclaims ~24% of the query-table
footprint and centralizes normalization: re-canonicalizing becomes a dimension
rebuild, not a full fact re-ingest.

### 3. Reject surrogate-int dictionary encoding of the fact column

Do not replace the `query_canonical` varchar with a `query_canonical_id` int on
fact rows. Validation shows ~3% gain with RLE-regression risk; Parquet's own
dictionary encoding already captures the repetition. The dimension table (2)
supersedes this idea.

## Consequences

- Phase 1 is self-contained: a new `RollupDef`, a read-path branch in
  `compile.ts` preferring the rollup when present and falling back to the live
  window query when absent (safe incremental rollout, no fact migration).
- Phase 2 is a larger blast radius: fact schema change across four tables,
  ingest writes the dimension instead of the per-row column, and every reader
  that selects `queryCanonical` joins through the dimension. Gate behind its own
  migration; phase 1 delivers most of the value without it.
- Rollup freshness: variant grouping reflects the last sync/compaction, not the
  live tail. Acceptable for grouping metadata; document it on the `RollupDef`.
- Stale-canonical-on-rule-change is resolved by phase 2 (rebuild the dimension);
  until then it remains an ingest-time bake, unchanged from today.
