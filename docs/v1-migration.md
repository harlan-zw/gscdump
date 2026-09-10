# v1 breaking changes and migration

Use this guide when updating package imports, CLI scripts, or a hosted integration.
The API wire version is `1.0`, separate from npm package versions.
Check each consumer against the deployed host before removing its legacy calls.

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
package's emitted `dist` layout ([export surface decision](./adr/0012-export-surface-tracks-consumers.md)).

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
`@gscdump/analysis/source`. The SDK root has no export.
Use `@gscdump/sdk/v1` for hosted calls or a documented helper subpath.

The SQLite factory creates an `AnalysisQuerySource`; its old names have no aliases.
The lakehouse maintenance subpath contains supported cleanup and retry helpers.

## Runtime and package-family baseline

- All published packages now require Node.js 22 or newer.
- Published runtime links within the package family use compatible `^` ranges;
  workspace development continues to resolve the local packages.
- DuckDB-WASM development is pinned to `1.33.1-dev57.0`, matching the production
  consumer. The optional peer range is `^1.33.1-dev57.0`, which accepts that
  tested build and compatible stable 1.x releases.
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
- `@gscdump/sdk/archetype` `builderStateToArchetype(siteId, state, opts?)`: the shared
  BuilderState-to-ArchetypeQuery compiler (returns `null` for
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

## Hosted v1 operations

The public v1 registry has 55 HTTP operations on `@gscdump/contracts/v1`
and `@gscdump/sdk/v1`: 50 partner, three analytics, and two realtime HTTP
operations. The API wire version remains `1.0`. See the [generated OpenAPI files](../packages/contracts/generated)
for the exact registry and the
[hosted v1 integration guide](./guides/hosted-v1.md) for consumer setup.

Legacy `createPartnerClient` and `createAnalyticsClient` exports remain, but many corresponding host routes have been removed.
Use the [producer inventory](./hosted-api-inventory.md) to check individual operations.

## CLI and MCP migration

| Earlier usage | Current usage |
| --- | --- |
| `npx gscdump` | `npx -y @gscdump/cli` |
| `@gscdump/mcp` | `gscdump mcp` from `@gscdump/cli` |
| `sync --db` | `config set dataDir`, then `sync` into a Parquet Store |
| `dump --period` or `dump --dimensions` | `query --start ... --end ... --dimensions ... --output ...` |
| `index request` | `indexing submit <url>` for eligible URLs |
| `inspect -u <url>` | `inspect <url>` |
| Analysis imports from `gscdump` | `@gscdump/analysis` or its registry and Report subpaths |

These are command replacements, not a SQLite data migration.
Back up old files before changing your data workflow.
See [getting started](./guides/getting-started.md) and [historical data](./guides/historical-database.md).
Indexing notifications must meet [Google's eligibility requirements](./guides/url-indexing.md#send-eligible-indexing-notifications).

## Consumer checks

If a consumer uses local workspace links, verify it with published package versions before release.
Test the operation's authentication, inputs, response parsing, and failure handling against the deployed host.
For browsers, also verify the proxy and realtime ticket flow.
