# v1 breaking changes and migration

Audience: the two consumers (`gscdump.com`, `nuxtseo.com`) and CLI/MCP users.
Both consumers were migrated in lockstep with these changes; this records what
changed and why for the v1 release notes.

## Removed export subpaths

| Removed | Replacement |
| --- | --- |
| `gscdump/api` | `gscdump` (the package root is the only Google API client barrel) |
| `@gscdump/sdk/query` | `gscdump/query` |
| `@gscdump/engine/snapshot` | `SnapshotIndex` re-exported from `@gscdump/engine` |
| `@gscdump/engine/r2-manifest` | `createR2ManifestStore` (+ option types) re-exported from `@gscdump/engine` |
| `@gscdump/engine/compaction` | none (zero consumers; the public-only wrapper was deleted while engine compaction remains internal) |
| `@gscdump/engine-sqlite/r2-manifest-schema` | tables remain on `@gscdump/engine-sqlite` root |
| `@gscdump/analysis/analyzer` | analyzers via `@gscdump/analysis` root or `/registry` |
| `@gscdump/analysis/semantic` | none (the Transformers-backed content-gap experiment had no production consumer) |

`@gscdump/engine/vendor/hysnappy` is intentionally kept: `gscdump.com`
resolves that public export for its Worker-safe alias without depending on the
package's emitted `dist` layout (ADR-0012).

## Renamed and relocated exports

| Before v1 | v1 replacement |
| --- | --- |
| `@gscdump/engine-sqlite` `createEngine` | `createSqliteQuerySource` |
| `@gscdump/engine-sqlite` `EngineConfig` | `SqliteQuerySourceOptions` |
| `@gscdump/lakehouse/unsafe-raw` `sweepUncommittedOrphans` and sweep types | `@gscdump/lakehouse/maintenance` |
| `@gscdump/lakehouse/unsafe-raw` `isCommitRateLimited` | `@gscdump/lakehouse/maintenance` |
| `@gscdump/engine` schema exports | `@gscdump/engine/schema` |
| `@gscdump/engine` ingest exports | `@gscdump/engine/ingest` |
| `@gscdump/engine` ingest accumulator exports | `@gscdump/engine/ingest-accumulator` |
| `@gscdump/engine` planner exports | `@gscdump/engine/planner` |
| `@gscdump/engine` resolver exports | `@gscdump/engine/resolver` |
| `@gscdump/engine` rollup exports | `@gscdump/engine/rollups` |
| `@gscdump/engine` source exports | `@gscdump/engine/source` |
| `@gscdump/engine` SQL binding exports | `@gscdump/engine/sql` |

Focused utility imports are now available at `@gscdump/engine/entity-keys`,
`@gscdump/lakehouse/bigint`, `@gscdump/lakehouse/schema`, and
`@gscdump/analysis/source`. The SDK root remains a compatibility aggregate;
new code should use its documented domain subpaths.

The SQLite names are a hard rename without deprecated aliases: the factory
creates an `AnalysisQuerySource`, not a storage engine. The lakehouse move
keeps stable application maintenance separate from raw Icebird primitives.

## Runtime and package-family baseline

- All published packages now require Node.js 22 or newer.
- Published runtime links within the package family use compatible `^` ranges;
  workspace development continues to resolve the local packages.
- DuckDB-WASM development is pinned to `1.33.1-dev57.0`, matching the production
  consumer. The optional peer range is `^1.33.1-dev57.0`, which accepts that
  tested build and compatible stable 1.x releases.
- The release lockfile forces Hono `4.12.31` so the CLI dependency graph does
  not retain the vulnerable `4.12.23` release.

## Canonical package ownership

- `gscdump` owns direct Google Search Console, Indexing, Site Verification,
  OAuth, and sitemap APIs. The duplicate `gscdump/api` barrel is gone.
- `gscdump/query` owns strict `BuilderState`, query construction, filters, and
  normalization. `@gscdump/contracts` owns the permissive transport shape,
  now explicitly named `BuilderStateWire`; the SDK no longer re-exports either
  type family.
- `@gscdump/contracts` owns hosted wire types, schemas, routes, and archetype
  constructors. `@gscdump/sdk` owns transport clients and transport-only
  helpers; `AnalyticsClient` and `PartnerClient` moved to SDK, while wildcard
  contract, archetype, and date re-exports were removed.
- `@gscdump/lakehouse` owns dataset-agnostic Iceberg connections, catalog
  operations, schema types, and datasets. Stable operational workflows and
  classifiers (`sweepUncommittedOrphans`, `isCommitRateLimited`) live at
  `@gscdump/lakehouse/maintenance`; catalog enumeration uses the root
  `listIcebergTables(conn)` wrapper. The explicit `unsafe-raw` escape hatch is
  reserved for raw Icebird primitives and package adapters.
  `@gscdump/engine/iceberg` now exposes only GSC dataset schemas, constants,
  catalog wrappers, file resolution, and its append sink.

## Removed legacy partner operations (partner surface only)

Deleted from the legacy `@gscdump/contracts` routes and `PartnerClient`:
`contentVelocity`, `ctrCurve`, `darkTraffic`, `deviceGap`, `keywordBreadth`,
and `positionDistribution`, plus `gscdumpDateRangeParamsSchema` /
`GscdumpDateRangeParams` and SDK `dateRangeQuery`. The analysis operations
later returned as descriptor-driven v1 methods. Import
`createGscdumpV1Client` from `@gscdump/sdk/v1`; do not restore the legacy
methods.

## Promoted APIs (consumer code moved into packages)

- `gscdump/query` `normalizeBuilderState(Result)` now owns wire-boundary
  hardening: orderBy shape coercion (canonical `{column, dir}`, legacy
  `[{column, desc}]`, `{column, desc}`) and malformed-filter-leaf rejection
  with new `QueryError` kind `'invalid-filter'`
  (`queryErrors.malformedFilterLeaf()`). Hosts map that error to a 4xx instead
  of maintaining local hardening wrappers.
- `@gscdump/sdk` `builderStateToArchetype(siteId, state, opts?)`: the single
  fail-closed BuilderState→ArchetypeQuery compiler (returns `null` for
  unrepresentable predicates; previously duplicated in both consumers with
  divergent drop semantics). Also `extractWireDateRange`,
  `archetypeSeamSupportsQuery`.
- `gscdump/dates` is the sole owner of `currentPstDate` / `daysAgoPst`; SDK
  re-exports were removed.
- `@gscdump/contracts` `SEARCH_TYPE_CAPABILITIES` +
  `searchTypeSupportsQueries` / `searchTypeSupportsDimensions`: search-type
  capability facts previously mirrored in consumer UI code.
- Analytics bulk-source and query-dimension source responses now have shared
  contract schemas, endpoint descriptors, and SDK methods instead of loose
  consumer-local response objects. Deployed partner control operations for
  sitemap actions, team/catalog management, user-site id crosswalks, and site
  verification now likewise have schemas, descriptors, and client methods.

## Direct Google API stability and performance

- `gscdumpApi(...)` and `GscdumpApiOptions` were deleted. Use
  `googleSearchConsole(...)` for direct Google calls; hosted gscdump.com
  transport lives in `@gscdump/sdk/v1`.
- The ambiguous root `daysAgo` export was removed. Import `daysAgoUtc` or
  `daysAgoPst` from `gscdump/dates`, or the Pacific query-builder `daysAgo`
  from `gscdump/query`.
- Root-only CLI implementation helpers (`progressBar`, `formatErrorForCli`,
  `rowWithMetricDefaults`) are no longer public exports.
- `gscdump` now owns structural Search Console and Indexing wire types. The
  optional `@googleapis/searchconsole` and `@googleapis/indexing` peers were
  removed, so consumers no longer need Google client packages to resolve
  `gscdump` declarations.
- Direct client requests have a 30-second default timeout via
  `DEFAULT_GSC_REQUEST_TIMEOUT_MS`; callers can still override it.
- Search Analytics is public as `client.searchAnalytics.query(...)`; the
  `_rawQuery` escape hatch was removed.
- `batchInspectUrlsFlatSettled(...)` provides ordered, per-URL outcomes with
  bounded concurrency (default 1, hard maximum 10), replacing unbounded
  consumer `Promise.all` inspection loops.
- OAuth exchange/refresh results preserve granted `scope`. Token introspection
  and revocation now have both errors-as-values and throwing APIs:
  `introspectAccessTokenResult` / `introspectAccessToken` and
  `revokeOAuthTokenResult` / `revokeOAuthToken`.
- Resolver callers can opt into `minimumImpressions`. It injects a raw-row
  `impressions >= n` prefilter for direct row/totals queries to reduce scans;
  comparison queries deliberately ignore it so lost/declining rows remain
  observable.

## Hosted v1 posture

The public v1 surface has 51 accepted operations on `@gscdump/contracts/v1`
and `@gscdump/sdk/v1`: 46 partner, three analytics, and two realtime HTTP
operations. The API wire version remains `1.0`; the checked-in package version
is `1.4.11`. See the [generated OpenAPI files](../packages/contracts/generated)
for the exact registry and the
[hosted v1 integration guide](./guides/hosted-v1.md) for consumer setup.

Legacy `createPartnerClient` / `createAnalyticsClient` remain for the
enumerated compatibility remainder. Deletion stays gated on operation
promotion or host-private classification.

## Consumer note

Both consumer repos temporarily override `@gscdump/*` to local links against
the local package checkout for pre-release verification. Remove those
overrides (restore catalog semver) when v1 publishes.
