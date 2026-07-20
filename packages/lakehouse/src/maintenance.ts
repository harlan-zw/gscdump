/**
 * Stable lakehouse maintenance operations.
 *
 * These helpers operate on package-owned {@link IcebergConnection} and
 * storage interfaces. Raw `icebird` primitives remain isolated behind
 * `@gscdump/lakehouse/unsafe-raw` for package adapters and diagnostics.
 */

export { isCommitRateLimited } from './catalog'
export { sweepUncommittedOrphans } from './orphan-sweep'

export type {
  SweepListedObject,
  SweepListPage,
  SweepStorageClient,
  SweepUncommittedOrphansOptions,
  SweepUncommittedOrphansResult,
} from './orphan-sweep'
