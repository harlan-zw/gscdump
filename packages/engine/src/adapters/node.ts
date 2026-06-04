// Single Node entrypoint barrel. Concentrates all Node-specific primitives
// behind one subpath (`@gscdump/engine/node`): the blocking DuckDB handle,
// the filesystem-wired harness, and the parquet/snapshot attach helpers.

export { createNodeDuckDBHandle, resetNodeDuckDB } from './duckdb-node'
export type { NodeDuckDBOptions } from './duckdb-node'

export { createNodeHarness } from './node-harness'
export type { NodeHarness, NodeHarnessOptions } from './node-harness'

export { attachParquetIndex } from './parquet-attach'
export type { AttachParquetIndexOptions, AttachParquetIndexResult } from './parquet-attach'

export { attachSnapshotIndex, attachSnapshotIndexResult, snapshotAlias } from './snapshot-attach'
export type {
  AttachSnapshotOptions,
  AttachSnapshotResult,
  SnapshotQueryRunner,
} from './snapshot-attach'
