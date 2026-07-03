export { icebergAppendRetrying, isCommitRateLimited } from './catalog'
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
export { icebergAppend, icebergCreateTable, icebergDropTable, icebergManifests, restCatalogConnect, restCatalogCreateNamespace, restCatalogListTables, restCatalogLoadTable, s3SignedResolver } from 'icebird'
