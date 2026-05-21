/**
 * Edge-safe `Sink` storage-layer implementations for the Iceberg
 * re-architecture.
 *
 * - {@link createInMemorySink} — unit-test fake; rows in memory.
 * - {@link createIcebergAppendSink} — prod; `icebird` `icebergAppend()`
 *   directly against the R2 Data Catalog. Edge-safe (icebird is Workers-first).
 *
 * Both conform to the frozen `Sink` contract in `../sink.ts`.
 *
 * `createLocalIcebergSink` is Node-only (statically imports `node:*`) and
 * therefore lives in `../sink-node.ts` / the `@gscdump/engine/sink-node`
 * subpath, NOT here — so this module and the main barrel stay edge-safe.
 */

export { createIcebergAppendSink } from './iceberg-append-sink'
export type { IcebergAppendSink } from './iceberg-append-sink'

export { createInMemorySink } from './in-memory-sink'
export type { InMemorySink, StoredRow } from './in-memory-sink'
