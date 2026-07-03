/**
 * Node-only `Sink` entry — kept OUT of the main `@gscdump/engine` barrel
 * because the PyIceberg overwrite writer statically imports `node:child_process`
 * / `node:path` / `node:url`, which break any browser/edge bundle.
 *
 * Import from `@gscdump/engine/sink-node` in Node-only code (integration
 * tests, scheduled job boxes). The edge-safe sinks live on the main barrel
 * (`createInMemorySink`) and `@gscdump/engine/iceberg`
 * (`createIcebergAppendSink`).
 *
 * `LocalIcebergSink` (the PyIceberg-subprocess test sink) was DELETED
 * (ADR-0021 / R2-FIXES C1) — confirmed non-load-bearing: every CI assertion
 * self-skipped without the docker+python POC stack it required.
 */

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
