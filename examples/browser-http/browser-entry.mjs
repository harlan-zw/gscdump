// Single entry point for the browser-http demo. Re-exports everything the
// browser needs so esbuild can produce one bundle.

export {
  analyzeInBrowser,
  analyzeWithDuckDB,
  attachParquetIndex,
  attachSnapshotIndex,
} from '@gscdump/analysis/duckdb'

export {
  createInsightRunner,
  mergeScope,
  page_keywords,
  resolveWindow,
  schema,
  scopeFor,
  strikingMomentum,
} from '@gscdump/analysis/browser'

export {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
  encodeSiteId,
} from 'gscdump/analytics'

export {
  createHttpDataSource,
  createHttpManifestStore,
} from 'gscdump/analytics/http'
