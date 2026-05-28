/**
 * Node-only `Sink` entry — kept OUT of the main `@gscdump/engine` barrel
 * because `LocalIcebergSink` statically imports `node:child_process` /
 * `node:path` / `node:url`, which break any browser/edge bundle.
 *
 * Import from `@gscdump/engine/sink-node` in Node-only code (integration
 * tests, scheduled job boxes). The edge-safe sinks (`createInMemorySink`,
 * `createIcebergAppendSink`) remain on the main barrel.
 */

export { createLocalIcebergSink } from './sinks/local-iceberg-sink'
export type {
  LocalIcebergSink,
  LocalIcebergSinkFullOptions,
} from './sinks/local-iceberg-sink'
