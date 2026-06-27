/**
 * Node-only `Sink` entry — kept OUT of the main `@gscdump/engine` barrel
 * because `LocalIcebergSink` statically imports `node:child_process` /
 * `node:path` / `node:url`, which break any browser/edge bundle.
 *
 * Import from `@gscdump/engine/sink-node` in Node-only code (integration
 * tests, scheduled job boxes). The edge-safe sinks live on the main barrel
 * (`createInMemorySink`) and `@gscdump/engine/iceberg`
 * (`createIcebergAppendSink`).
 */

export { createLocalIcebergSink } from './iceberg/local-sink'
export type {
  LocalIcebergSink,
  LocalIcebergSinkFullOptions,
} from './iceberg/local-sink'
export {
  createIcebergOverwriteWriter,
  deleteSiteFromShard,
  httpBackend,
  overwriteWriterAsSink,
  subprocessBackend,
} from './iceberg/overwrite-writer'
export type {
  DeleteJob,
  DeleteSiteResult,
  IcebergOverwriteWriter,
  IcebergOverwriteWriterOptions,
  OverwriteBackend,
  OverwriteJob,
  OverwriteJobResult,
  OverwriteWriterCatalogConfig,
  PyIcebergJob,
} from './iceberg/overwrite-writer'
export type { LocalIcebergSinkOptions } from './sink'
