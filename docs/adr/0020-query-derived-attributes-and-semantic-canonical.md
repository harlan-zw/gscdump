# 0020. Query-derived attributes live in the versioned query dimension; semantic (embedding) canonical is the accuracy ceiling

- Status: partially implemented (query dimension + lexical intent classifier
  built; embeddings remain roadmap)
- Implemented: `query_dim` entity store + `buildQueryDimRecords`
  (`packages/engine/src/query-dim.ts`), the `classifyQueryIntent` lexical
  classifier with a packed integer encoding (`encodeIntent`,
  `packages/analysis/src/query/intent.ts`), and `query_canonical_daily` deriving
  canonical from the dimension via JOIN when present (else the stored column).
- Date: 2026-06-23
- Builds on ADR-0017 (canonical is a dimension), ADR-0019 (normalization is
  versioned). Answers two design questions: (a) should query intent (brand,
  how-to, …) be materialized? (b) can the canonical be semantic — "group by
  anything close enough"?

## Context

We are introducing a versioned `query → canonical` dimension (`query_dim`):
one row per distinct query, built offline in JS, keyed by query, recording the
canonical plus the `NORMALIZER_VERSION` that produced it. Both new questions are
about *attributes derived from the query string*. The dimension is the natural
home for all of them — fact tables keep only the raw `query`, and rollups / read
paths JOIN the dimension to derive everything else.

The governing test for "materialize vs compute at query time" is:

> Is the attribute a **pure, stable function of the query string**, or does it
> depend on **mutable / per-tenant** config?

Pure + stable → materialize in the dimension, versioned by its producer, so it
can be filtered/aggregated via a JOIN and rebuilt cheaply on a rule change.
Tenant-relative or mutable → compute at query time, or in a small tenant-scoped
overlay rebuilt when its config changes.

## Decision

### 1. The query dimension is the home for all query-pure derived attributes

`query_dim` columns, each independently versioned:

| attribute | producer / version | notes |
| --- | --- | --- |
| `canonical` (lexical) | `NORMALIZER_VERSION` | ADR-0019 |
| `intent_*` flags (how-to, informational, comparison, transactional) | `classifierVersion` | pure lexical classifier |
| `embedding` (vector) | `embeddingModelVersion` | offline model inference |
| `cluster_id` (semantic canonical) | `embeddingModelVersion` + `threshold` | greedy clustering of embeddings |

Fact tables keep only `query`. A rollup/read derives any attribute by JOINing
`query_dim` (the ADR-0018 `query_canonical_daily` rollup already JOINs by query;
extend its projection). Each attribute's version gates its own rebuild — a
classifier change re-runs only the intent pass, not the whole pipeline.

### 2. Intent: materialize the lexical ones, keep brand at query time

- **Lexical intents** (how-to / informational / comparison / transactional) are
  pure functions of the query → materialize as `intent_*` flags in the
  dimension, tagged `classifierVersion`. Enables "how-to traffic share",
  "filter to comparison queries", etc. as cheap JOIN-and-group.
- **Brand** is per-tenant and mutable (the user edits brand terms) → NOT in the
  shared dimension. Baking a shared brand flag is cross-tenant-incorrect (`nuxt
  seo` is brand for one site, generic for another) and goes stale on every
  brand-term edit. Compute at query time (cheap label over the result page) or
  in a tenant-scoped overlay rebuilt on brand-term change. Consumer already does
  this in `brand.ts`.

### 3. Semantic canonical via embeddings — phased, and *complementary* not replacement

"Group by anything close enough" is a clustering problem, not a string function:
there is no canonical *string*, only a cluster the query is assigned to.

**Pipeline (offline / compaction-time, server-side — never edge):**

1. **Lexical pre-pass (done).** `normalizeQuery` (v2) collapses trivial variants
   first, so we embed distinct *lexical canonicals*, not raw queries — far fewer
   items, cheaper.
2. **Embed.** One vector per distinct lexical-canonical, cached in `query_dim`
   (only embed new ones). Candidate model: a small sentence encoder
   (MiniLM / bge-small). The earlier browser content-gap experiment and its
   optional `@huggingface/transformers` peer were removed for v1 because
   neither production consumer used them; a future server-side pipeline must
   choose and own its runtime explicitly. Record `embeddingModelVersion`.
3. **Cluster — greedy, traffic-ordered (deterministic).** Process items by
   descending traffic; each joins the nearest existing cluster centroid with
   cosine-sim ≥ `threshold`, else starts a new cluster. The first (highest-
   traffic) member becomes the cluster's display name. Given (model, threshold,
   traffic order) the assignment is deterministic and stable. `cluster_id` is the
   semantic canonical.
4. **Read.** Rollups GROUP BY `cluster_id` via the same dimension JOIN as the
   lexical canonical — no read-path change beyond which dimension column is the
   key.
5. **Incremental + rebuild.** New queries embed + nearest-cluster assign cheaply
   (ANN). A periodic full re-cluster + `threshold`/`embeddingModelVersion` bump
   repairs drift; versioning makes stale clusters detectable, never silently
   mixed.

**Why complementary, not a replacement for lexical canonical:**

- Embedding clustering can **over-merge** (`react tutorial` ≈ `vue tutorial` are
  close but distinct) and is **threshold-sensitive and opaque**. Making it THE
  canonical risks silent, unexplainable mis-grouping.
- Keep the **lexical canonical as the default, stable, explainable key**; expose
  `cluster_id` as an *alternative* grouping the query/UI can opt into ("group
  semantically" / "related queries"). Both live in the dimension; the read path
  picks the column. This is strictly safer than hard-replacing the canonical.

## Consequences

- The dimension becomes the single versioned home for everything derived from a
  query; adding an attribute is additive and independently rebuildable.
- Brand stays correct-by-construction (never shared/stale) by living at query
  time.
- Embeddings are tractable because they run over lexical-canonicals, cache in
  the dimension, and only touch the read path as a JOIN column — but they are a
  heavyweight *offline* capability (model inference, ANN, tuning) and are gated
  behind their own versions. Treat as a later phase; lexical canonical ships the
  grouping value now.
- Open tuning questions for the embedding phase: similarity `threshold`,
  re-cluster cadence, model choice, and evaluation (precision/recall of merges
  against a hand-labelled set) — none blocking the dimension itself.
