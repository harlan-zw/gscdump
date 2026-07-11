# gscdump

Real-time Google Search Console querying with an append-only Parquet/DuckDB store. The vocabulary below is load-bearing across packages — drift here causes shallow modules and accidental duplication.

## Language

### Storage & data

**Schema**:
The canonical drizzle pg-core tables in `@gscdump/engine/schema` (`pages`, `keywords`, `countries`, `devices`, `page_keywords`). Single source of truth; the parquet `SCHEMAS` map and the sqlite-core variant are derived from or drift-checked against it.
_Avoid_: tables, models, columns-as-source-of-truth.

**Engine**:
A storage runtime — DuckDB-Node, DuckDB-WASM, SQLite/D1, or GSC live-API — that produces a `Source` consumers can query. Distinct from the **Driver** it wraps.
_Avoid_: backend, store, datastore.

**Driver**:
The low-level runtime binding an **Engine** wraps: an `AsyncDuckDB` handle, a sqlite-proxy executor, an R2 bucket. Analyzers never see one.
_Avoid_: connection, client (overloaded).

### Query plumbing

**Source** (`AnalysisQuerySource`):
The query abstraction analyzers consume. Single Interface; `queryRows` always present, `executeSql` opt-in via `capabilities.executeSql` (the flag and the method move together — factories set both or neither). Capability flags advertise everything else: planner caps (`regex`, `comparisonJoin`, `windowTotals`, `multiDataset`), storage caps (`attachedTables`, `fileSets`). The `kind` tag (`local | browser | live | in-memory | composite | attached-table`) is telemetry only — never used for routing. The deep seam between analyzers and engines.
_Avoid_: provider, repository, query service. Don't reintroduce a `RowQuerySource`/`SqlQuerySource` discriminated union — the capability flag is the single source of truth.

**Adapter** (`ResolverAdapter<TableKey>`):
Dialect-specific translator that compiles `BuilderState` → `{ sql, params }` against a drizzle schema. Two real variants: `pgResolverAdapter` (DuckDB; single-tenant) and `sqliteResolverAdapter` (SQLite/D1; multi-tenant via `site_id`). Built via `createResolverAdapter`.
_Avoid_: compiler, translator, dialect.

**Archetype Query**:
Typed hosted analytics query contract exported from `@gscdump/contracts/archetypes`. Describes the finite server-tail/browser query shapes (`site-daily-timeseries`, `top-n-breakdown`, `arbitrary-sql`, etc.) and their execution class without owning transport or SQL execution.
_Avoid_: keeping archetype contracts in `@gscdump/sdk`; SDK may re-export them but does not own them.

**Archetype SQL compiler**:
Server-tail compiler that turns an `ArchetypeQuery` into `{ sql, params, table }` with a `{{TABLE}}` placeholder. Runtime adapters substitute the concrete table reference; browser/WASM keeps its own compiler because attached partition bindings use a different contract.
_Avoid_: per-runtime server-tail SQL builders.

**Analyzer** (`Analyzer<P, R>`):
Pure contract `{ id, requires, build, reduce }`. Two families: `ROW_ANALYZERS` (against rows) and `SQL_ANALYZERS` (against `SqlQuerySource`). Dispatched by `runAnalyzerFromSource(source, params, registry)`.
_Avoid_: tool, report, query.

**Rollup** (`RollupDef`):
Post-sync aggregate written to `u_<u>/<s>/rollups/<id>__v<ts>.{json,parquet}`. Cheap reads, fixed shape. JSON for small widgets; parquet for server-side-filterable tables. The opt-in canonical-primary set (`CANONICAL_ROLLUPS`: `query_canonical_daily`, `query_canonical_variants`) is materialized from the **Query Dimension** and consumed via the read-path overlay seams. Distinct from analyzers, which run on demand.
_Avoid_: aggregate, summary, snapshot (collides with **Entity** snapshots).

**Entity**:
Per-site slow-changing state, point-lookup-by-id — URL inspections, sitemap snapshots, indexing-metadata events, the query dimension. Distinct family from time-series facts.
_Avoid_: record (overloaded), object.

**Canonical Query** (`query_canonical`; `normalizeQuery` in `@gscdump/analysis`):
The grouping key for near-duplicate search queries — unicode-folded, lowercased, singularized, bag-of-words sorted (except asymmetric `X to Y` conversions), versioned by `NORMALIZER_VERSION`. Fact-table reads derive it by joining the **Query Dimension** and falling back to raw `query`; canonical rollups may materialize the derived `query_canonical` output. See ADR-0018/0019.
_Avoid_: slug, hash. Don't bake brand into it (brand is per-tenant + mutable).

**Query Dimension** (`query_dim`; `createQueryDimStore`):
Per-site **Entity** mapping each distinct `query → { canonical, intent_code, normalizer_version, intent_version }`, built offline. The versioned home for everything derived from a query string; rollups/reads JOIN it, so re-canonicalizing is a dimension rebuild, not a fact re-ingest. The natural home for a future per-canonical embedding. See ADR-0017/0020.
_Avoid_: lookup table, cache.

**Search Intent** (`classifyQueryIntent`):
Lexical, versioned (`INTENT_CLASSIFIER_VERSION`) class of a raw query — informational / commercial / transactional / unknown, plus a `howTo` flag, packed to a small int (`encodeIntent`). Query-pure → materialized in the dimension or computed at query time. Brand intent is deliberately excluded (per-tenant + mutable). See ADR-0020.
_Avoid_: category, tag.

**GSC Date Semantics** (`gscdump/dates`):
Lightweight date seam separating UTC storage arithmetic (`daysAgoUtc`, `MS_PER_DAY`, `toIsoDate`) from Search Console's Pacific reporting calendar (`daysAgoPst`, freshness/finalization helpers). Engine, analysis, browser, and CLI code import this subpath instead of the compatibility root.
_Avoid_: an unqualified `daysAgo` outside the query-builder compatibility surface; it hides whether a UTC or Pacific day was intended.

**Read-path overlay seam** (`canonicalSource`, `resolveExtra`):
Opt-in hooks on `runOptimizedQuery` that let the MAIN query read a materialized canonical rollup, and extras read a variant rollup, instead of re-aggregating facts — gated so a miss falls back to live aggregation (correct, never wrong). See ADR-0017/0018.
_Avoid_: cache, materialized view (it's a fallback-gated source override).

**PyIceberg writer runtime**:
Private Engine adapter for Python-backed Iceberg append/overwrite jobs. Owns the Python interpreter fallback and subprocess JSON contract; storage writers build jobs and interpret domain results.
_Avoid_: each writer reading PyIceberg env defaults or parsing writer stdout independently.

### Tenancy & layout

**Manifest authority**:
The component that owns the live pointer for a `(siteId, table)` shard. Filesystem `ManifestStore` is single-writer; R2-native uses HEAD pointer + immutable snapshot with `etagMatches` CAS for concurrent writers.
_Avoid_: index, registry.

**searchType partition**:
First-class partition dimension on `WriteCtx`/`ManifestEntry`/`SyncStateScope`. Non-`web` types (`discover`, `news`, `googleNews`, `image`, `video`) get a `<table>/<searchType>/` path segment; `web` preserves legacy paths.
_Avoid_: vertical, channel.

**Compaction tier** (`CompactionTier`):
`raw | d7 | d30 | d90`. Tier on each `ManifestEntry` so input cohorts are unambiguous (later tiers don't re-pick their own output).
_Avoid_: level, generation.

### Hosted APIs

**Hosted surface**:
A public API plane with its own routes and wire schemas. The partner control plane lives under `@gscdump/contracts/partner`; the analytics data plane lives under `@gscdump/contracts/analytics`. The contracts root stays as compatibility aggregation.
_Avoid_: using `partnerEndpointSchemas` as a catch-all for unrelated hosted APIs.

**Hosted requester**:
SDK-private HTTP transport factory for hosted clients. Owns base-path joining, headers/API-key merge, validation phase policy, and partner error mapping. Surface clients own endpoint-specific schemas and method names.
_Avoid_: duplicating request helpers in each hosted SDK client.

**Search Console API surface**:
The direct Google Search Console / Indexing / Site Verification client surface published as `gscdump/api`. The package root remains a compatibility barrel; API-only consumers should import this subpath.
_Avoid_: importing the `gscdump` root when only Google API client operations or types are needed.

## Relationships

- An **Engine** wraps a **Driver** and produces a **Source**
- A **Source** uses an **Adapter** to compile typed builder state to dialect SQL
- An **Analyzer** consumes a **Source** via `runAnalyzerFromSource`
- A **Rollup** is written by the sync path; an **Analyzer** is run on demand
- The **Manifest authority** is the single source of truth for which parquet files belong to a `(siteId, table, searchType)` shard

## Flagged ambiguities

- "engine" was previously used for both storage runtime and `SqlQuerySource` factory (e.g. `createEngine` in adapter packages). Resolved 2026-05: **Engine** is the storage runtime; the factory is `createSqlQuerySource` (or `createEngineQuerySource` for partitioned-Parquet sources). See ADR-0001.
- "browser engine" formerly implied a canonical-schema DuckDB-WASM source. Resolved 2026-05: in the browser there is no canonical-schema source — only `createAttachedTableSource` over per-partition parquet attaches. See ADR-0001.
