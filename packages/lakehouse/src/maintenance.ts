/**
 * Stable lakehouse maintenance operations.
 *
 * These helpers operate on package-owned {@link IcebergConnection} and
 * storage interfaces. Raw `icebird` primitives remain isolated behind
 * `@gscdump/lakehouse/unsafe-raw` for package adapters and diagnostics.
 */

export { isCommitRateLimited, isCommitServerError, isCommitTransient } from './catalog'
export { mergeIcebergManifests } from './manifest-merge'
export type { MergeIcebergManifestsOptions, MergeIcebergManifestsResult } from './manifest-merge'
export { sweepUncommittedOrphans } from './orphan-sweep'
export type {
  SweepListedObject,
  SweepListPage,
  SweepStorageClient,
  SweepUncommittedOrphansOptions,
  SweepUncommittedOrphansResult,
} from './orphan-sweep'
export { expireIcebergSnapshots, planIcebergSnapshotRetention } from './snapshot-retention'
export type { ExpireIcebergSnapshotsOptions, ExpireIcebergSnapshotsResult, PlanIcebergSnapshotRetentionOptions, PlanIcebergSnapshotRetentionResult } from './snapshot-retention'
export { restoreIcebergTable } from './table-restore'

export type { RestoreIcebergTableOptions, RestoreIcebergTableResult } from './table-restore'
