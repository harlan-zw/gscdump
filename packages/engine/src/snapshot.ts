/**
 * Describes a hot/cold snapshot set. Produced by the snapshot builder,
 * consumed by `attachSnapshotIndex`. Filenames are derived from `cold`
 * via `cold-${yearMonth}.duckdb`; hot is always `hot.duckdb` when
 * `hot: true`.
 */
export interface SnapshotIndex {
  version: 1
  builtAt: string // YYYY-MM-DD (UTC)
  cold: string[] // YYYY-MM keys, sorted ascending
  hot: boolean
  hotDays: number
}
