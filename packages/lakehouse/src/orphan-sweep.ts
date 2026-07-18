/**
 * Never-committed orphan sweep for the R2 Data Catalog (ADR-0021 amendment,
 * R2-FIXES F2).
 *
 * Cloudflare's own snapshot-expiration GC (live since 2026-04-22) already
 * reclaims data files that WERE referenced by a since-expired snapshot. The
 * one class it does NOT cover — Cloudflare's documented carve-out — is a
 * data file a writer PUT under a table's `data/` directory that never made
 * it into any snapshot's manifest at all (a crash between the object write
 * and the manifest/snapshot commit). This sweep closes that specific gap.
 *
 * Approach: for each table, load its current metadata, derive the bucket
 * key prefix under which its data files live (`<table.location>/data/` —
 * see `icebird`'s write path: every data/delete/deletion-vector file is
 * written as `${tableUrl}/data/${uuid}[...] .parquet|.puffin`, flat, no
 * per-snapshot subdirectory), list every object under that prefix, and
 * subtract every file referenced by ANY snapshot the table still retains —
 * not just the current one. An older-but-not-yet-expired snapshot's files
 * are still legitimately live (time-travel, in-flight readers); only
 * Cloudflare's own expiration decides when a snapshot (and therefore the
 * files it alone references) stops being retained. What's left after that
 * subtraction, older than `graceHours`, is the never-committed orphan set.
 */

import type { IcebergConnection } from './catalog'
import { icebergManifests, restCatalogListTables, restCatalogLoadTable } from 'icebird'

/** One listed object under a data prefix. */
export interface SweepListedObject {
  key: string
  uploaded: Date
}

/** One page of a prefix listing. */
export interface SweepListPage {
  objects: readonly SweepListedObject[]
  truncated: boolean
  cursor?: string
}

/**
 * Minimal storage client `sweepUncommittedOrphans` needs: list-by-prefix +
 * batch delete against the warehouse bucket. Deliberately NOT an S3 SDK
 * client shape — this interface is structurally satisfied by Cloudflare's
 * native `R2Bucket` Workers binding (`env.R2_ANALYTICS.list({ prefix })` /
 * `env.R2_ANALYTICS.delete(keys)`), so a caller running inside a Worker can
 * pass the binding straight through with no adapter. Any other
 * S3-compatible client can be wrapped to this shape.
 */
export interface SweepStorageClient {
  list: (options: { prefix: string, cursor?: string }) => Promise<SweepListPage>
  delete: (keys: string[]) => Promise<void>
}

export interface SweepUncommittedOrphansOptions {
  conn: IcebergConnection
  s3: SweepStorageClient
  /**
   * Bare R2 bucket name backing `conn`'s warehouse. Every scanned table's
   * `location` must resolve into this exact bucket; a table whose location
   * points elsewhere is SKIPPED — never guessed at, never touched.
   */
  bucket: string
  /**
   * Restrict the sweep to these tables; defaults to every table currently
   * in `conn.namespace` (`conn` already carries the namespace scope, so
   * there's no separate `namespace` field here).
   */
  tables?: readonly string[]
  /** Only delete objects older than this many hours. Default 48. */
  graceHours?: number
  /** Hard cap on deletions in one run. Default 500. */
  maxDeletes?: number
  /** Compute the delete set but never call `s3.delete`. Default false. */
  dryRun?: boolean
  /** Injectable clock (ms epoch). Defaults to `Date.now`. */
  now?: () => number
  /** Maximum catalog/object-store reads held in flight. Default 4, max 32. */
  ioConcurrency?: number
}

export interface SweepUncommittedOrphansResult {
  /** Tables whose retained snapshots were successfully walked. */
  scannedTables: string[]
  /** Tables skipped because their `location` didn't resolve into `bucket` — never scanned, never touched. */
  skippedTables: string[]
  /** Count of live (referenced-by-some-retained-snapshot) files found across `scannedTables`. */
  liveFileCount: number
  /** Objects under a scanned table's data prefix with no snapshot reference anywhere, past `graceHours`. */
  candidateCount: number
  /** Keys deleted (or, under `dryRun`, that WOULD be deleted). */
  deleted: string[]
  dryRun: boolean
  /** True when `candidateCount` exceeded `maxDeletes` — remaining orphans are left for the next run. */
  cappedAtLimit: boolean
  /** Set when the sweep did nothing because the table scope listed zero tables (fail-closed — see class docs). */
  reason?: 'zero-tables'
}

const DEFAULT_GRACE_HOURS = 48
const DEFAULT_MAX_DELETES = 500
const DEFAULT_IO_CONCURRENCY = 4
const MAX_IO_CONCURRENCY = 32
const HOUR_MS = 60 * 60 * 1000

type IoLimiter = <T>(operation: () => Promise<T>) => Promise<T>

function createIoLimiter(requested: number | undefined): IoLimiter {
  const concurrency = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_IO_CONCURRENCY, Math.floor(requested)))
    : DEFAULT_IO_CONCURRENCY
  let active = 0
  const waiters: Array<() => void> = []
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= concurrency)
      await new Promise<void>(resolve => waiters.push(resolve))
    active++
    try {
      return await operation()
    }
    finally {
      active--
      waiters.shift()?.()
    }
  }
}

async function settleOrThrow<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises)
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure)
    throw failure.reason
  return settled.map(result => (result as PromiseFulfilledResult<T>).value)
}

function splitBucketKey(filePath: string): { bucket: string, key: string } | null {
  if (!filePath.startsWith('s3://'))
    return null
  const rest = filePath.slice('s3://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0)
    return null
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) }
}

interface TableScanResult {
  /** null when the table's location doesn't resolve into the expected bucket. */
  dataPrefix: string | null
  liveKeys: Set<string>
}

/**
 * Every data-file key referenced by ANY retained snapshot of `table` (not
 * just the current one), plus the bucket-relative `data/` prefix its files
 * live under. Errors from the REST catalog / manifest walk are NOT caught
 * here — they propagate to the caller, which must fail closed rather than
 * treat a listing failure as "no live files" (see module docs).
 */
async function scanTable(
  conn: IcebergConnection,
  table: string,
  bucket: string,
  io: IoLimiter,
): Promise<TableScanResult> {
  const { metadata } = await io(() => restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table }))
  const location = splitBucketKey(String(metadata.location ?? ''))
  if (!location || location.bucket !== bucket)
    return { dataPrefix: null, liveKeys: new Set() }

  const dataPrefix = `${location.key.replace(/\/+$/, '')}/data/`
  const liveKeys = new Set<string>()
  const snapshots = metadata.snapshots ?? []
  const manifestsBySnapshot = await settleOrThrow(snapshots.map(snapshot =>
    io(() => icebergManifests({ metadata, resolver: conn.resolver, snapshotId: snapshot['snapshot-id'] })),
  ))
  for (const manifests of manifestsBySnapshot) {
    for (const manifest of manifests) {
      for (const entry of manifest.entries) {
        // status 2 = DELETED (removed as of THIS manifest) — not live at this
        // snapshot. status 0/1 (EXISTING/ADDED) are live. Deliberately NOT
        // filtering on `data_file.content` — position/equality delete files
        // also live under `<location>/data/` (icebird's write path) and must
        // be protected the same as data files, or they'd be misclassified as
        // orphans.
        if (entry.status === 2)
          continue
        const filePath = entry.data_file?.file_path
        if (!filePath)
          continue
        const parsed = splitBucketKey(filePath)
        if (parsed && parsed.bucket === bucket)
          liveKeys.add(parsed.key)
      }
    }
  }
  return { dataPrefix, liveKeys }
}

async function listAllUnderPrefix(s3: SweepStorageClient, prefix: string, io: IoLimiter): Promise<SweepListedObject[]> {
  const out: SweepListedObject[] = []
  let cursor: string | undefined
  do {
    const page = await io(() => s3.list({ prefix, cursor }))
    out.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/**
 * Sweep data files written under a table's `data/` prefix that were NEVER
 * referenced by any snapshot the catalog still retains — a crashed/partial
 * writer's leftovers. This is the one orphan class Cloudflare's own R2 Data
 * Catalog snapshot-expiration GC does not cover.
 *
 * HARD SAFETY:
 * - A listing failure (table load / manifest walk throwing) PROPAGATES.
 *   It is never caught and treated as "no live files" — that would make
 *   every real data file look orphaned. Callers must let this reject and
 *   must not proceed to delete on catch.
 * - Zero tables in scope is treated as "couldn't determine what's live",
 *   not "nothing to protect" — the sweep no-ops with `reason: 'zero-tables'`
 *   rather than listing/deleting anything.
 * - Deletions are capped at `maxDeletes` per run (default 500).
 * - `dryRun` computes the exact candidate set without ever calling `s3.delete`.
 * - Only ever lists/deletes keys under a scanned table's own
 *   `<table.location>/data/` prefix, and every candidate is re-checked to
 *   actually start with that prefix before being considered for deletion —
 *   never a bare bucket-root listing, never a key outside a data prefix.
 */
export async function sweepUncommittedOrphans(
  opts: SweepUncommittedOrphansOptions,
): Promise<SweepUncommittedOrphansResult> {
  const { conn, s3, bucket } = opts
  const graceHours = opts.graceHours ?? DEFAULT_GRACE_HOURS
  const maxDeletes = opts.maxDeletes ?? DEFAULT_MAX_DELETES
  const dryRun = opts.dryRun ?? false
  const now = (opts.now ?? Date.now)()
  const graceCutoff = now - graceHours * HOUR_MS
  const io = createIoLimiter(opts.ioConcurrency)

  const tables = opts.tables ?? (await io(() => restCatalogListTables(conn.catalog, { namespace: conn.namespace }))).map(t => t.name)

  if (tables.length === 0) {
    return {
      scannedTables: [],
      skippedTables: [],
      liveFileCount: 0,
      candidateCount: 0,
      deleted: [],
      dryRun,
      cappedAtLimit: false,
      reason: 'zero-tables',
    }
  }

  const tableResults = await settleOrThrow(tables.map(async (table) => {
    // NOT wrapped in try/catch — a scan failure for any table must abort the
    // whole run (fail closed) rather than proceed on a partial live-set.
    const { dataPrefix, liveKeys } = await scanTable(conn, table, bucket, io)
    if (!dataPrefix)
      return { table, skipped: true as const, liveFileCount: 0, candidates: [] as SweepListedObject[] }

    const listed = await listAllUnderPrefix(s3, dataPrefix, io)
    const tableCandidates: SweepListedObject[] = []
    for (const obj of listed) {
      if (!obj.key.startsWith(dataPrefix))
        continue
      if (liveKeys.has(obj.key))
        continue
      if (obj.uploaded.getTime() > graceCutoff)
        continue
      tableCandidates.push(obj)
    }
    return { table, skipped: false as const, liveFileCount: liveKeys.size, candidates: tableCandidates }
  }))

  const scannedTables = tableResults.filter(result => !result.skipped).map(result => result.table)
  const skippedTables = tableResults.filter(result => result.skipped).map(result => result.table)
  const liveFileCount = tableResults.reduce((sum, result) => sum + result.liveFileCount, 0)
  const candidates = tableResults.flatMap(result => result.candidates)

  const candidateCount = candidates.length
  const toDelete = candidates.slice(0, maxDeletes)
  const cappedAtLimit = candidateCount > maxDeletes

  if (!dryRun && toDelete.length > 0)
    await s3.delete(toDelete.map(o => o.key))

  return {
    scannedTables,
    skippedTables,
    liveFileCount,
    candidateCount,
    deleted: toDelete.map(o => o.key),
    dryRun,
    cappedAtLimit,
  }
}
