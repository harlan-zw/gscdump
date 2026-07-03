/**
 * Escape hatch for the raw `icebird` primitives (ADR-0021 amendment 1).
 *
 * The registry (`defineIcebergDataset`) is the ENFORCED authoring surface —
 * these primitives are not exported from the package's main entrypoint so a
 * producer cannot silently bypass dataset defs and hand-roll a table (the
 * exact bug class the registry exists to close). Reach for this subpath only
 * when building a NEW abstraction on top of lakehouse (e.g. `@gscdump/engine`
 * re-exposing its own frozen `gsc.*` surface) — never from application code.
 */
export { icebergAppendRetrying, isCommitRateLimited } from './catalog'
// The never-committed orphan sweep (R2-FIXES F2) is built entirely on the
// primitives above (`restCatalogListTables` / `restCatalogLoadTable` /
// `icebergManifests`) plus an injected storage client — it's exactly the
// "new abstraction on top of lakehouse" this subpath exists for.
export { sweepUncommittedOrphans } from './orphan-sweep'

export type {
  SweepListedObject,
  SweepListPage,
  SweepStorageClient,
  SweepUncommittedOrphansOptions,
  SweepUncommittedOrphansResult,
} from './orphan-sweep'
export { icebergAppend, icebergCreateTable, icebergDropTable, icebergManifests, restCatalogConnect, restCatalogCreateNamespace, restCatalogListTables, restCatalogLoadTable, s3SignedResolver } from 'icebird'
