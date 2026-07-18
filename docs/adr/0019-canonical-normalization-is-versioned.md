# 0019. Canonical normalization is versioned; re-canonicalize before generating canonical tables

- Status: accepted (normalizer v2 implemented; re-canonicalization + dimension are follow-ups)
- Date: 2026-06-23
- Follows ADR-0017 / ADR-0018 (canonical as a dimension, fast read path). This
  ADR is about the canonical *values* themselves: the normalization quality and
  how to evolve it without silently corrupting history.

## Context

`query_canonical` is produced by `normalizeQuery` (`@gscdump/analysis`) and
baked onto every fact row at ingest. Two audits (2026-06-23) found:

1. **No algorithm versioning.** When `normalizeQuery` changes, already-stored
   `query_canonical` becomes stale; old and new keys mix silently, and the only
   recovery is a manual admin backfill. This makes the algorithm effectively
   unevolvable in place.
2. **Quality gaps in the v1 heuristic** — most materially: no Unicode folding
   (`café` ≠ `cafe`, full-width `ｓｅｏ` ≠ `seo`), and noise-only queries
   (`free`, `online`) normalizing to `''`.
3. The hand-rolled depluralize exception list silently corrupts words it
   doesn't list (`plus`→`plu`, `lotus`→`lotu`).

The alphabetical token-sort (`seo tools` ≡ `tools seo`) is a *feature* for
keyword grouping and is kept — with one refinement: word order is preserved for
asymmetric `X to Y` conversions (`json to yaml` ≠ `yaml to json`), detected by a
directional connector (`to`/`into`/`→`) used as a true infix whose left neighbour
isn't an idiom word (`how`/`guide`/`way`…). Symmetric comparisons (`react vs vue`)
and idioms (`how to …`) still sort and merge.

Gaps deliberately NOT changed: thin synonyms — expansion risks false merges. CJK
tokenization is out of scope for the current Latin/dev audience; the accurate
fix for semantic grouping is embeddings (a future layer on the canonical
dimension, not lexical normalization).

The trigger to act now: the canonical rollup/dimension tables (ADR-0017/0018)
are not yet mass-generated. Fixing normalization *before* first generation means
the tables are built on correct keys, instead of needing re-canonicalization
later.

## Decision

### 1. Ship the normalization quality fixes (done — v2)

`normalizeQuery` now: folds Unicode (`NFKD` + strip diacritics → `café`=`cafe`,
full-width → ASCII); guards the empty-canonical case (noise-only queries keep
their tokens instead of collapsing to `''`); and singularizes via the
`pluralize` library (guarded by the `NO_STRIP_S` tech-term skip list + a generic
`-sis` guard for Greek singulars), replacing the hand-rolled rules that produced
`plus→plu` / `lotus→lotu`. `pluralize` is ~2.5 KB min+gzip and lands only in the
ingest/sync bundle (the read path never normalizes). Synonyms, token-sort, and
idempotency are unchanged; all 16 original tests plus new edge-case tests green.

### 2. Version the normalizer (done)

`export const NORMALIZER_VERSION = 2`. Any future behaviour change MUST bump it.
Stores that materialize `query_canonical` (fact rows, the canonical dimension,
the rollups) should record the version that produced them, so staleness is
detectable and repairable rather than silent.

### 3. Re-canonicalize before generating the canonical tables (required follow-up)

The rollups read the STORED `query_canonical` (they cannot call the JS
normalizer from SQL), so they inherit whatever version produced the fact rows.
Existing stored canonical is v1. Therefore, before mass-generating
`query_canonical_daily` / `query_canonical_variants` (or the dimension), the
per-row `query_canonical` must be rebuilt with v2 — via the consumer's existing
canonical backfill path — else the tables bake in stale v1 keys. Gate the
backfill / generation on `NORMALIZER_VERSION`.

### 4. Defer (flagged, not done)

- **Versioned canonical dimension** (ADR-0017 Phase 2): makes re-canonicalization
  a single cheap rebuild (distinct queries) instead of a full fact re-ingest, and
  reclaims storage. The proper long-term home for (3).
- **Consumer R2-vs-D1 read divergence**: Pro/R2 reads currently group raw query
  while D1 reads group canonical. Consumer-repo scope; in progress (Iceberg
  sources already pass `canonicalFallback: true`).

## Consequences

- Normalization is now i18n-safer and never emits `''`; idempotency preserved.
- `NORMALIZER_VERSION` makes "which algorithm produced this canonical" a
  first-class, checkable fact — the missing piece that makes the algorithm
  evolvable.
- The operational ordering is now explicit: bump version → re-canonicalize
  stored data → generate canonical tables. Doing algorithm tweaks *after*
  generation is the trap this ADR exists to prevent.
