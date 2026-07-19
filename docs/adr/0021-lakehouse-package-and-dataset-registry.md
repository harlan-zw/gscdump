# ADR-0021: `@gscdump/lakehouse` — extract the dataset-agnostic Iceberg layer behind a dataset registry

Date: 2026-07-03
Status: Accepted, as amended by the same-day 3-lens adversarial review (see Review Amendments — they override the body where they conflict). Implementation tracked in nuxtseo R2-FIXES Track C.

## Context

Two producers now write Iceberg tables into the same per-team R2 Data Catalogs: gscdump.com (`gsc.*`, 9 tables) and nuxtseo.com (`crawl.*`, `lighthouse.*`, `dataforseo.*`, 4 tables). The engine's Iceberg layer (`packages/engine/src/iceberg/`) is dataset-agnostic in its storage/catalog mechanics but GSC-coupled at every declaration point: table names are string-literal unions, schemas live in frozen constants (`ICEBERG_SCHEMAS`/`TABLE_METADATA`), the `Sink` contract bakes in `searchType`, and the append sink hardcodes `site_id + search_type` identity injection.

The consequence is copy-paste reuse: nuxtseo defined 4 inline schemas and triplicated writer/catalog/listener/reconciler code, and the string→int site-id migration (2026-06-30) was applied per-writer by hand, missing one writer and three readers (nuxtseo R2-FIXES A1/A2/A5 — all silent-no-rows bugs). Nothing type-level forces a producer or reader to use the catalog's join key. The 2026-07-03 dependency-map pass established the precise split (see Inventory below).

## Decision

Create **`@gscdump/lakehouse`**: a new package in this monorepo owning the dataset-agnostic Iceberg layer, with a **dataset registry** as its public authoring surface. Consumers declare datasets; the package derives everything mechanical from the declaration.

### The registry

```ts
export interface IcebergDatasetDef {
  namespace: string // 'gsc' | 'crawl' | 'lighthouse' | 'dataforseo' | ...
  table: string
  /** Column spec (IcebergColumn[] shape reused from engine/iceberg/schema.ts). */
  schema: IcebergTableSpec
  /** Partition fields; identity columns must appear here. */
  partition: IcebergPartitionField[]
  /**
   * Identity model. 'site-int' = the team-scoped numeric Catalog Site Id
   * (nuxtseo ADR-0091): int32-guarded, single-allocator, decoded as int32 LE in
   * partition bounds. This is where the A1/A2/A5 bug class dies: writers,
   * dedupe, reader predicates, and bound decoding ALL derive from this field.
   */
  identity: { kind: 'site-int' } | { kind: 'custom', columns: string[] }
  /** Extra per-slice dimensions (GSC declares `searchType`); absent for snapshots. */
  dims?: Record<string, { toPartitionValue: (v: string) => string | number }>
  clusterKey?: string[]
  /** Consumer-owned exactly-once ledger shape (commit-then-record enforced). */
  ledger?: { key: readonly string[] }
}

export function defineIcebergDataset(def: IcebergDatasetDef): IcebergDataset
```

An `IcebergDataset` handle exposes: `createTable(conn)`, `appendSink(opts)` (buffer + one commit per table per close, dedupe by identity, cluster pre-sort, INT32 guard for `site-int`), `readerPredicate(siteKey)` + `partitionBoundFilter(siteKey, months)` (what nuxtseo's `catalog-sources.ts` and gscdump's `file-resolution.ts`/`cross-source.ts` consume), and `ledgerGuard(db, table)` helpers.

### What moves (from the 2026-07-03 dependency map)

- **Clean moves**: `catalog-cache.ts`, `partition-prune.ts` (partition spec becomes a parameter), and `catalog.ts`'s connect / ensureNamespace / list / drop / `icebergAppendRetrying` (+ append-id idempotency) / `listIcebergDataFiles` — all already take bare table names.
- **Parameterized in the move**: `sink.ts`'s `SinkSlice` generalizes `searchType` to `dims?: Record<string, string | number>`; `append-sink.ts`'s identity injection and `sortByClusterKey` read from the dataset def instead of `ICEBERG_SCHEMAS`/`TABLE_METADATA`; `catalog.ts`'s create-table helpers take a passed `IcebergTableSpec`.
- **Provisioning** (new to the package, consolidated from both apps): adopt-existing (fetch ref), self-provision (bucket + CORS + catalog enable + credential-set + **maintenance configs: compaction target 128MB + snapshot expiration** — nuxtseo's provisioner was missing the maintenance half), and supplied-catalog (accept external R2 storage details at registration: "provision a gscdump account with the R2 details and it just works"). Plus the **Catalog Site Id allocator** (team-scoped next-int over ALL existing ids including adopted gscdump `int_id`s; supplied ids validated for team-scope uniqueness). One allocator per team, owned here, never hand-rolled by a consumer.
- **Manifest-walk + presign core** (consolidated from gscdump `file-resolution.ts` and nuxtseo `catalog-sources.ts`): snapshot load, manifest walk with dataset-derived partition filter, SigV4 presign with signed size hint, cache contract (injected unstorage). The reader predicate comes from the dataset def, closing the reader half of the identity bug class.
- **Overlay reader half** (`engine-duckdb-wasm/overlay-view.ts` SQL merge + the file-resolution `overlay` field shape): moves as an optional capability — already fully generic.

### What stays

- `engine/src/schema.ts` + `drizzle-schema.ts`: become **GSC's registry instance** (the 9 `gsc.*` dataset defs, `SEARCH_TYPE_INT` as a `dims` declaration), not part of the package.
- `overwrite-writer.ts`: GSC-private (only GSC has third-party restatement semantics).
- `pyiceberg-runtime.ts`: stays with the GSC-private overwrite writer behind `@gscdump/engine/sink-node`. Re-exporting it from the Lakehouse root made the otherwise portable entry emit a static `node:process` import for a single consumer.
- The overlay **writer** half (`recent-overlay.ts` stability-cutoff machinery): gsc-private; crawl/lighthouse snapshots have no volatile tail, so generalizing it is speculative surface.
- Query dispatchers (seam, archetype server-tail), analyzers, DuckDB-WASM engine: separate concerns, separate packages/apps.
- **Deleted in the same change**: `local-sink.ts` + `packages/engine/test/local-iceberg-sink.test.ts` (PyIceberg subprocess path; confirmed non-load-bearing in CI — every assertion self-skips without the docker+python stack).

### Tenancy invariant (nuxtseo ADR-0091 §5, enforced here)

The package's write API takes a **team-scoped catalog handle** as its only target type; no global/default catalog is expressible. Team-scoped ids are meaningless outside their bucket, so any shared-store fallback is silent cross-tenant collision, not a degraded mode.

### Migration order (R2-FIXES Track C)

C1 mechanical move (imports rewritten atomically across engine, gscdump.com, nuxtseo — 26 + 10 files + `cloudflare/r2-sql-client.ts`; no back-compat re-exports) → C2 registry + port `gsc.*` → C3 provisioning consolidation → C4 shared resolution core → C5 collapse nuxtseo's writer triplets onto defs. Activation (Track E) is deliberately NOT gated on any of this.

## Alternatives considered

- **Subpath export from `@gscdump/engine`** (`engine/iceberg` already exists): rejected — the engine drags the legacy Gen-2 parquet system, GSC drizzle schemas, and ingest transforms; nuxtseo consuming a GSC-branded engine for crawl data obscures the boundary the registry exists to enforce.
- **Utils-only package without the registry**: rejected explicitly — it keeps the copy-paste and just moves the imports; the registry is the load-bearing deliverable (R2-FIXES Decision 3).
- **Per-app dataset definitions with a shared convention doc**: rejected — the A1/A2/A5 incident class is exactly what conventions-without-types produced.

## Review Amendments (2026-07-03, 3-lens adversarial panel — all accepted)

**API shape (lens: prevents-drift):**
1. **The registry is enforced, not opt-in.** Raw primitives (`icebergAppendRetrying`, `icebergCreateTable`, `icebergManifests`, `restCatalogLoadTable`) are NOT exported from the package's main entrypoint — they're internal, reachable only via `IcebergDataset` handles. A lint-flaggable `@gscdump/lakehouse/unsafe-raw` subpath is the sole escape hatch. Without this, all three current writers (which call primitives directly, not `Sink`) could keep bypassing the registry and the whole thesis collapses.
2. **No opaque `'custom'` identity.** Replaced with a closed, typed shape: `{ kind: 'columns', columns: { name: string, encoding: 'int32' | 'string' }[] }` — injection + bound-decode mechanically derived, same as `'site-int'`.
3. **Explicit `naturalKey: readonly string[]`** on the def; the dedupe key is documented as identity-columns + dims-columns + naturalKey (today's `dedupeByIdentity` semantics — identity alone would collapse rows).
4. **Encoding on identity**: `{ kind: 'site-int', encoding?: 'int' | 'string' }` (default int) so legacy string catalogs remain representable inside the registry rather than forking an ungoverned path.
5. **`dims` values carry `boundEncoding: 'int32' | 'string'`** (required) so reader-side manifest-bound decoding is derived, not guessed — the A5 bug shape at the dims layer.
6. **Ledger recording folds into `appendSink().close()`** (ledger def + record fn as sink options, recorded per flushed table). No standalone `ledgerGuard` that a caller could sequence wrongly.
7. Track C exit criterion: a cross-repo fixture test or connect-time dataset-version stamp so a stale consumer fails loudly.

**Boundary (lens: minimal-boundary):**
8. `iceberg/schema.ts` is explicitly SPLIT: the generic type shapes (`IcebergTableSpec`, `IcebergColumn`, `IcebergPartitionField`, `PartitionKeyEncoding`) move; `IcebergTableName`, `ICEBERG_TABLES`, `ICEBERG_SCHEMAS`, `SEARCH_TYPE_INT`, `ICEBERG_PARTITION_SPEC` stay with GSC's registry instance.
9. `listIcebergDataFiles` and `buildPartitionFilter` are RECLASSIFIED from "clean move" to "parameterized in the move" (both hardcode `siteId`/`searchType` dims + the frozen partition spec in signatures/cache keys); `icebergSortOrderFor`'s `TABLE_METADATA` read derives from the def's `clusterKey` instead.
10. `sink.ts` ownership decided: lakehouse defines its own minimal write contract (the generalized `SinkSlice` with `dims`); GSC's `Sink` becomes a thin adapter over it in the engine.
11. Provisioning ships behind a **subpath split** (`@gscdump/lakehouse/provisioning`): it's cold/admin, needs the wider Account API token, and must not be bundleable into the per-request ingest Worker path. Same package (shares `IcebergDatasetDef`), separate entrypoint.
12. Re-grep the full blast radius before C1 (`@gscdump/cloudflare` imports engine in 5 files, not just `r2-sql-client.ts`; counts recorded in R2-FIXES were same-day stale).

**Migration (lens: migration-cost):**
13. **The "atomic workspace-linked" premise is FALSE for `@gscdump/engine`** — both apps consume published tarballs via catalog pins (only `@gscdump/sdk` is link:-ed). C1 is three publish/bump/deploy cycles. Resolution: **major-bump `@gscdump/engine`** when its `iceberg` subpath is gutted, so caret ranges cannot float onto the breaking version; downstream repos opt in explicitly with their import rewrites. (The "no back-compat re-exports" rule survives — the major bump replaces the need for a compat window.)
14. `local-sink.ts` deletion also covered its `sink-node.ts` barrel consumers:
    `gscdump.com/test/iceberg/{archetypes,backfill-rehearsal}.integration.test.ts`
    were deleted because they imported `createLocalIcebergSink` at module top
    (collection-time failure even though their bodies self-skipped). Future
    audits must grep `sink-node`, not just `/iceberg`.
15. **Port order inverted: nuxtseo's snapshot tables FIRST, `gsc.*` second.** The first production consumer of a never-shipped abstraction must be the lowest-blast-radius one (crawl/lighthouse/dataforseo: simple defs, zero prod rows at port time), not the revenue-bearing `gsc.*` exercising 100% of the surface (dims + ledger + restatement adjacency) on day one. R2-FIXES C2/C5 are resequenced accordingly.
16. **PyIceberg runtime placement stays GSC-private.** The subprocess runtime has one production consumer (`engine/iceberg/overwrite-writer.ts`) and imports `node:process`/`node:child_process`. It therefore lives behind the existing `@gscdump/engine/sink-node` runtime seam instead of the portable `@gscdump/lakehouse` root. This amends the original “clean moves” inventory above.

## Consequences

- Adding a dataset becomes a declaration, not a fork; identity/encoding rules are enforced at one point.
- Both apps take a new workspace dependency; SDK/browser packages are unaffected.
- GSC's schema-versioning policy (additive columns bump `schemaVersion`, `union_by_name` NULL-fill) becomes a registry-level contract all datasets inherit.
- The engine shrinks to: GSC dataset instance, resolver/analyzer layers, legacy Gen-2 code (deleted separately once the Iceberg orphan sweep lands — R2-FIXES F2/D4).
