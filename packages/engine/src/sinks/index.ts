/**
 * Generic, feature-agnostic `Sink` implementations.
 *
 * - {@link createInMemorySink} — unit-test fake; rows in memory.
 *
 * The edge-safe Iceberg sink (`createIcebergAppendSink`) lives behind
 * `@gscdump/engine/iceberg` and conforms to the `Sink` contract in
 * `../sink.ts`. Node-only recovery writers live on `./sink-node`.
 */

export { createInMemorySink } from './in-memory-sink'
export type { InMemorySink, StoredRow } from './in-memory-sink'
