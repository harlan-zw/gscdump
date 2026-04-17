export { AnalyzerUnsupportedError, analyzeWithDuckDB, buildAnalyzerSpec } from './analyze'
export type { AnalyzerSpec, DuckDBAnalyzeDeps, FileSet } from './analyze'
export { analyzeInBrowser, rewriteForTableSource } from './browser'
export type { AnalyzerRunner, BrowserAnalyzeOptions } from './browser'
export { attachParquetIndex } from './parquet-attach'
export type { AttachParquetIndexOptions, AttachParquetIndexResult } from './parquet-attach'
export { attachSnapshotIndex, snapshotAlias } from './snapshot-attach'
export type {
  AttachSnapshotOptions,
  AttachSnapshotResult,
  SnapshotQueryRunner,
} from './snapshot-attach'
