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

**Analyzer** (`Analyzer<P, R>`):
Pure contract `{ id, requires, build, reduce }`. Two families: `ROW_ANALYZERS` (against rows) and `SQL_ANALYZERS` (against `SqlQuerySource`). Dispatched by `runAnalyzerFromSource(source, params, registry)`.
_Avoid_: tool, report, query.

**Rollup** (`RollupDef`):
Post-sync JSON aggregate written to `u_<u>/<s>/rollups/<id>__v<ts>.json`. Cheap reads, fixed shape. Distinct from analyzers, which run on demand.
_Avoid_: aggregate, summary, snapshot (collides with **Entity** snapshots).

**Entity**:
Per-site slow-changing state, point-lookup-by-id — URL inspections, sitemap snapshots, indexing-metadata events. Distinct family from time-series facts.
_Avoid_: record (overloaded), object.

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

## Relationships

- An **Engine** wraps a **Driver** and produces a **Source**
- A **Source** uses an **Adapter** to compile typed builder state to dialect SQL
- An **Analyzer** consumes a **Source** via `runAnalyzerFromSource`
- A **Rollup** is written by the sync path; an **Analyzer** is run on demand
- The **Manifest authority** is the single source of truth for which parquet files belong to a `(siteId, table, searchType)` shard

## Flagged ambiguities

- "engine" was previously used for both storage runtime and `SqlQuerySource` factory (e.g. `createEngine` in adapter packages). Resolved 2026-05: **Engine** is the storage runtime; the factory is `createSqlQuerySource` (or `createEngineQuerySource` for partitioned-Parquet sources). See ADR-0001.
- "browser engine" formerly implied a canonical-schema DuckDB-WASM source. Resolved 2026-05: in the browser there is no canonical-schema source — only `createAttachedTableSource` over per-partition parquet attaches. See ADR-0001.
