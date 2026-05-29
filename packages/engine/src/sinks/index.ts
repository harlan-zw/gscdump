/**
 * Generic, feature-agnostic `Sink` implementations.
 *
 * - {@link createInMemorySink} — unit-test fake; rows in memory.
 *
 * Iceberg sinks (`createIcebergAppendSink`, edge-safe) live behind
 * `@gscdump/engine/iceberg`; the Node-only `createLocalIcebergSink` is on
 * `@gscdump/engine/sink-node`. Both conform to the frozen `Sink` contract in
 * `../sink.ts`.
 */

export { createInMemorySink } from './in-memory-sink'
export type { InMemorySink, StoredRow } from './in-memory-sink'
