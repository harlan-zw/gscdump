# 0018. Canonical query as the primary lookup key: opt-in totalness now, materialised grain next

- Status: accepted (Gap 1 + Gap 2 implemented; consumer wiring outstanding)
- Date: 2026-06-23
- Builds on ADR-0017 (canonical query is a dimension; variant grouping is a
  rollup). Migration style follows the schema-version precedent
  (`TABLE_METADATA.version`, `hourly_pages` hour→INT v2): legacy behaviour
  preserved, the correctness fix opt-in per call.

## Context

The intended access pattern is canonical-primary: top / gaining / losing
keyword lookups should group by `query_canonical`, not the raw `query`.
`queryCanonical` is already a first-class dimension that flows through one
chokepoint (`resolver/fragments.ts` `dimExprSql`), so the main optimized query
emits `GROUP BY query_canonical` + `SUM(...)` and the comparison path joins
`c.queryCanonical = p.queryCanonical`. The grouping wiring is clean.

Three gaps stop it from being clean *as the primary key*:

1. **Nullable / empty canonical corrupts results.** `query_canonical` is
   nullable, there is no `COALESCE` fallback anywhere, and the three read paths
   disagree on nulls: the main query *includes* them (a NULL super-bucket
   summing all un-normalised traffic into top results), the comparison path
   *mismatches* them (`NULL = NULL` is UNKNOWN, so a null-canonical keyword
   present in both windows surfaces as a phantom "new" row *and* a phantom
   "lost" row), and the variant extras / rollup *filter* them
   (`WHERE query_canonical IS NOT NULL`). `normalizeQuery` also returns `''` for
   fully-stripped queries ("free online"), collapsing unrelated terms into one
   empty bucket. The consumer wires `normalizeQuery` at D1 ingest today, so
   freshly-synced D1 rows are populated, but historical/backfill rows and the
   entire R2 path carry NULL/'' canonical.

2. **Canonical metrics are recomputed every read.** ADR-0017 Phase 1
   materialised only variant *metadata*. As the primary grain, the main query
   (and twice for comparison) re-aggregates raw `(query × date) → canonical` on
   every request, single-threaded under DuckDB-WASM/Workers.

3. **Consumer still groups by raw query.** `gscdump.com` keywords page passes
   `dimensions: ['query']`; the R2 read path does not surface canonical or
   variants at all. Canonical-primary is therefore also a consumer migration,
   tracked in that repo.

## Decision

### 1. Opt-in `canonicalFallback` makes canonical a total key (Gap 1 — implemented)

A `canonicalFallback` flag threads from `RunOptimizedQueryOptions` /
`runComparisonQuery` / `createParquetResolverAdapter` /
`createIcebergResolverAdapter` into `SqlFragmentsConfig`. When set, the single
`dimExprSql` chokepoint emits, for `queryCanonical`:

```sql
COALESCE(NULLIF(query_canonical, ''), query)
```

so SELECT, GROUP BY, and the comparison join key all fold NULL/'' back to the
row's own raw query. Canonical becomes total: no NULL/'' bucket in top results,
and gaining/losing matches across windows instead of double-counting. Default
`false` preserves the legacy raw-nullable-column behaviour — same opt-in shape
as the search-type int and hour→INT migrations. `queryCanonical` only resolves
on tables that also carry `query`, so the fallback column reference is always
valid.

Filtering by `queryCanonical` still uses the raw column (`dimensionPredicates`
goes through `colRef`, not `dimExprSql`); folding the fallback into canonical
filters is a follow-up, not required for grouping/comparison correctness.

### 2. Materialise a canonical-grained fact aggregate (Gap 2 — implemented)

`queryCanonicalDailyRollup` (`query_canonical_daily`) pre-sums the raw
`(query × date)` rows to `(query_canonical × date) → SUM(clicks, impressions,
sum_position)`, maintained at sync/compaction as a sibling of the tiered fact
tables. It is written with the Gap 1 `COALESCE(NULLIF(query_canonical, ''),
query)` expression, so it is null-free by construction and the read path needs
no fallback when pointed at it. Metrics are additive (ctr/position are derived
from summed clicks/impressions/sum_position in the outer SELECT), so summing the
per-date sums over a window is exact — verified equal to live raw aggregation
for both top and gaining/losing.

Read path: `RunOptimizedQueryOptions.canonicalSource` (object keys of the
rollup) makes the MAIN query read the pre-summed rows; variant extras still read
raw. Three gates must all pass, else the live path serves the query (a mis-wired
host degrades to correct-but-slow, never wrong):

1. `canonicalRollupCovers` — groups solely by `queryCanonical`/date, filters
   only date/`queryCanonical`, no per-row metric prefilter or top-level page
   filter (the rollup dropped those columns / the raw grain).
2. `canonicalFallback` is on — the rollup is built with COALESCE (total-key)
   semantics, so serving it to a legacy caller would change NULL/'' rows from
   buckets to raw-query keys. The rollup READ itself runs without fallback (it
   is already null-free and lacks the raw `query` column).
3. `coversThrough` — the window end is at/before the rollup's newest covered
   date, so the recent tail is never silently undercounted.

To keep all key producers on one key space, the live `buildExtrasQueries`, the
`query_canonical_variants` rollup, and `query_canonical_daily` all key on the
same `COALESCE(NULLIF(query_canonical, ''), query)` (the variant rollups thereby
also drop their old `IS NOT NULL` filter). The build runs in byte-bounded date
windows (`runWindowed`) so a large tenant never exceeds the Workers RPC Arrow
cap. Opt-in: not in `DEFAULT_ROLLUPS` (exported as `CANONICAL_ROLLUPS`, built via
`gscdump rollups --with-canonical`); default reads unchanged.

**Date storage.** The rollup's `date` column is a native parquet DATE (INT32 +
`converted_type: DATE`) via the flex encoder, matching the fact tables and the
Iceberg path — not a string. With `parquetSortKey: ['date', 'query_canonical']`,
row groups carry DATE min/max stats, so the date-range filter on the read path
prunes row groups. This matters because the rollup is full-history and every
read windows by date.

### 3. Keep the canonical grain embedding-ready (forward-looking)

A likely future need is a semantic embedding per canonical query. The correct
home is a table keyed *by canonical* (the Gap 2 canonical grain, or the ADR-0017
Phase 2 `query → canonical` dimension), one row per canonical — never the
per-row fact tables, which would store the vector millions of times over. This
package need not implement embeddings; the requirement is only that the
canonical-keyed table introduced by Gap 2 / ADR-0017 Phase 2 leaves room for a
nullable `embedding` column (or a co-keyed `canonical_embeddings` parquet),
populated out-of-band. Designing canonical as a keyed entity — rather than a
denormalised per-row string — is what makes embeddings cheap to add later.

## Consequences

- Gap 1 is self-contained and shipped: one expression behind a default-off flag,
  no schema or data migration, legacy reads unchanged. Engine tests cover the
  legacy pollution, the folded grouping, and the comparison double-count→match.
- The consumer opts in by (a) passing `canonicalFallback: true` and switching
  the keyword dimension to `queryCanonical` (safe), (b) building
  `query_canonical_daily` in its rollup set and passing its keys as
  `canonicalSource` (fast). Until then behaviour is identical to today.
- Gap 2 reuses the rollup + opt-in seam infrastructure from ADR-0017; the only
  new fact-shaped object is one opt-in parquet rollup, no fact-table migration.
- Treating canonical as a keyed grain (Gap 2 / ADR-0017 Phase 2) is the decision
  that unlocks both the storage reclaim and future per-canonical enrichment
  (embeddings, brand tags) without touching the fact tables.
