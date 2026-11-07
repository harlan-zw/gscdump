import type { IcebergConnection } from './catalog'
import type { CatalogCache } from './catalog-cache'
import { restCatalogLoadTable, restCatalogUpdateTable } from 'icebird/src/catalog/rest.js'
import { invalidateSnapshotRef } from './catalog'

export interface ExpireIcebergSnapshotsOptions {
  /** Snapshots at or after this timestamp remain available. */
  olderThanMs: number
  /** Keep at least this many newest snapshots, independently of age. */
  retainLast: number
  /** The caller owns in-flight writes, recovery, and rollback retention. */
  protectedSnapshotIds: readonly string[]
  /** Recheck caller authority. The caller excludes branch/tag changes through commit settlement. */
  confirmAuthority: () => Promise<boolean>
  /** Bound each metadata mutation. The default is one thousand removals. */
  maxExpired?: number
  cache?: CatalogCache
}

export type ExpireIcebergSnapshotsResult
  = | { _tag: 'Expired', snapshotIds: string[], retained: number }
    | { _tag: 'Unchanged' }
    | { _tag: 'Conflict' }
    | { _tag: 'Err', reason: 'invalid-options' | 'invalid-inventory' | 'unsupported-refs' | 'authority-changed' }

/**
 * Remove old snapshot metadata while retaining the current data-file inventory.
 * No object is deleted. Callers must establish their own replay and restore window.
 */
export async function expireIcebergSnapshots(conn: IcebergConnection, table: string, options: ExpireIcebergSnapshotsOptions): Promise<ExpireIcebergSnapshotsResult> {
  const maxExpired = options.maxExpired ?? 1000
  if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0
    || !Number.isSafeInteger(options.retainLast) || options.retainLast < 1
    || !Number.isSafeInteger(maxExpired) || maxExpired < 1 || maxExpired > 1000) {
    return { _tag: 'Err', reason: 'invalid-options' }
  }
  const { metadata } = await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })
  const snapshots = metadata.snapshots ?? []
  const currentId = metadata['current-snapshot-id']
  if (snapshots.length === 0 && (currentId === undefined || currentId === null) && options.protectedSnapshotIds.length === 0)
    return { _tag: 'Unchanged' }
  const invalid = { _tag: 'Err', reason: 'invalid-inventory' } as const
  if (!metadata['table-uuid'] || currentId === undefined || currentId === null)
    return invalid
  const inventory = new Map<string, (typeof snapshots)[number]>()
  for (const snapshot of snapshots) {
    const id = String(snapshot['snapshot-id'])
    if (!/^\d+$/.test(id) || inventory.has(id) || !Number.isSafeInteger(snapshot['timestamp-ms']) || snapshot['timestamp-ms'] < 0)
      return invalid
    inventory.set(id, snapshot)
  }
  const head = String(currentId)
  if (!inventory.has(head) || options.protectedSnapshotIds.some(id => !inventory.has(id)))
    return invalid
  const refs = metadata.refs ?? {}
  if (Object.keys(refs).some(name => name !== 'main'))
    return { _tag: 'Err', reason: 'unsupported-refs' }
  if (refs.main && (refs.main.type !== 'branch' || String(refs.main['snapshot-id']) !== head))
    return invalid
  const ordered = snapshots.toSorted((a, b) => b['timestamp-ms'] - a['timestamp-ms'] || (BigInt(a['snapshot-id']) < BigInt(b['snapshot-id']) ? 1 : -1))
  const keep = new Set([head, ...options.protectedSnapshotIds, ...ordered.slice(0, options.retainLast).map(snapshot => String(snapshot['snapshot-id']))])
  const expired = ordered.toReversed().filter(snapshot => snapshot['timestamp-ms'] < options.olderThanMs && !keep.has(String(snapshot['snapshot-id']))).slice(0, maxExpired)
  if (expired.length === 0)
    return { _tag: 'Unchanged' }
  if (!await options.confirmAuthority())
    return { _tag: 'Err', reason: 'authority-changed' }
  const committed = await restCatalogUpdateTable(conn.catalog, {
    namespace: conn.namespace,
    table,
    requirements: [{ type: 'assert-table-uuid', uuid: metadata['table-uuid'] }, { 'type': 'assert-ref-snapshot-id', 'ref': 'main', 'snapshot-id': currentId }],
    updates: [{ 'action': 'remove-snapshots', 'snapshot-ids': expired.map(snapshot => snapshot['snapshot-id']) }],
  }).then(value => ({ _tag: 'Committed' as const, value }), (error: unknown) => {
    if (typeof error === 'object' && error !== null && 'status' in error && (error.status === 409 || error.status === 412))
      return { _tag: 'Conflict' as const }
    throw error
  })
  if (committed._tag === 'Conflict')
    return { _tag: 'Conflict' }
  const removed = new Set(expired.map(snapshot => String(snapshot['snapshot-id'])))
  const expected = new Set([...inventory.keys()].filter(id => !removed.has(id)))
  const acknowledged = committed.value.metadata
  const actual = acknowledged.snapshots?.map(snapshot => String(snapshot['snapshot-id'])) ?? []
  if (acknowledged['table-uuid'] !== metadata['table-uuid'] || String(acknowledged['current-snapshot-id']) !== head
    || actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some(id => !expected.has(id))) {
    throw new Error('Snapshot expiry acknowledgement does not match the committed plan.')
  }
  if (options.cache)
    await invalidateSnapshotRef(options.cache, conn.namespace, table, conn.cacheScope)
  return { _tag: 'Expired', snapshotIds: expired.map(snapshot => String(snapshot['snapshot-id'])), retained: actual.length }
}
