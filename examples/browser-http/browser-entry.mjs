// Single entry point for the browser-http demo. Re-exports everything the
// browser needs so esbuild can produce one bundle.

export {
  analyzeInBrowser,
  attachParquetIndex,
  attachSnapshotIndex,
} from '@gscdump/engine-duckdb-node'

export {
  createInsightRunner,
  mergeScope,
  page_keywords,
  resolveWindow,
  schema,
  scopeFor,
  strikingMomentum,
} from '@gscdump/engine-wasm'

export { encodeSiteId } from 'gscdump/tenant'
export {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '@gscdump/engine'

export {
  createHttpDataSource,
  createHttpManifestStore,
} from '@gscdump/engine/http'
