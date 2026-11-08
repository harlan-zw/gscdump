import type { IcebergConnection } from './catalog'
import type { CatalogCache } from './catalog-cache'
import { restCatalogLoadTable, restCatalogRegisterTable } from 'icebird/src/catalog/rest.js'
import { parseIcebergJson } from 'icebird/src/json.js'
import { invalidateSnapshotRef } from './catalog'

export interface RestoreIcebergTableOptions {
  /** Immutable metadata object restored before its Catalog registration. */
  metadataLocation: string
  metadataSha256: string
  tableUuid: string
  headSnapshotId: string | null
  /** Complete snapshot identity inventory from the saved metadata. */
  snapshotIds: readonly string[]
  /** The caller excludes writers and owns the target through settlement. */
  confirmAuthority: () => Promise<boolean>
  /** Defaults to 16 MiB. The maximum is 64 MiB. */
  maxMetadataBytes?: number
  cache?: CatalogCache
}

export type RestoreIcebergTableResult
  = | { _tag: 'Restored', tableUuid: string, snapshotIds: string[] }
    | { _tag: 'Err', reason: 'invalid-options' | 'target-exists' | 'backup-invalid' | 'authority-changed' }
    | { _tag: 'Unknown', reason: 'request-failed', cause: unknown }
    | { _tag: 'Unknown', reason: 'acknowledgement-invalid' | 'authority-changed' }

function validOptions(table: string, options: RestoreIcebergTableOptions): boolean {
  const maxBytes = options.maxMetadataBytes ?? 16 * 1024 * 1024
  return table.length > 0 && table.length <= 255
    && /^s3:\/\/[a-z0-9][a-z0-9.-]+\/[^\s?#]+$/.test(options.metadataLocation)
    && /^[a-f0-9]{64}$/.test(options.metadataSha256)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.tableUuid)
    && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024
    && options.snapshotIds.length <= 100_000
    && options.snapshotIds.every(id => /^(?:0|[1-9]\d{0,18})$/.test(id))
    && new Set(options.snapshotIds).size === options.snapshotIds.length
    && (options.headSnapshotId === null ? options.snapshotIds.length === 0 : options.snapshotIds.includes(options.headSnapshotId))
}

function matchesBackup(loaded: { metadataLocation: unknown, metadata: unknown }, options: RestoreIcebergTableOptions): boolean {
  if (!loaded.metadata || typeof loaded.metadata !== 'object' || Array.isArray(loaded.metadata))
    return false
  const metadata = loaded.metadata as Record<string, unknown>
  const snapshots = metadata.snapshots ?? []
  if (!Array.isArray(snapshots) || snapshots.some(snapshot => !snapshot || typeof snapshot !== 'object'))
    return false
  const ids = snapshots.map(snapshot => String(snapshot['snapshot-id']))
  const expected = new Set(options.snapshotIds)
  const rawHead = metadata['current-snapshot-id']
  const head = rawHead == null || String(rawHead) === '-1' ? null : String(rawHead)
  return loaded.metadataLocation === options.metadataLocation && metadata['table-uuid'] === options.tableUuid
    && head === options.headSnapshotId && ids.length === expected.size
    && new Set(ids).size === expected.size && ids.every(id => expected.has(id))
}

/** Restore a verified metadata pointer into an empty target. Never replace an existing table. */
export async function restoreIcebergTable(conn: IcebergConnection, table: string, options: RestoreIcebergTableOptions): Promise<RestoreIcebergTableResult> {
  if (!validOptions(table, options))
    return { _tag: 'Err', reason: 'invalid-options' }
  if (!await options.confirmAuthority())
    return { _tag: 'Err', reason: 'authority-changed' }
  const existing = await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table }).then(
    () => true,
    (error: unknown) => {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404)
        return false // An absent registration is required for restoration.
      throw error
    },
  )
  if (existing)
    return { _tag: 'Err', reason: 'target-exists' }
  const reader = await conn.resolver.reader(options.metadataLocation)
  const maxBytes = options.maxMetadataBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(reader.byteLength) || reader.byteLength <= 0 || reader.byteLength > maxBytes)
    return { _tag: 'Err', reason: 'backup-invalid' }
  const bytes = new Uint8Array(await reader.slice(0, reader.byteLength))
  if (bytes.byteLength !== reader.byteLength)
    return { _tag: 'Err', reason: 'backup-invalid' }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  if (sha256 !== options.metadataSha256)
    return { _tag: 'Err', reason: 'backup-invalid' }
  let metadata: unknown
  try {
    metadata = parseIcebergJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  catch {
    // Malformed archive bytes are an expected backup failure, before any registration.
    return { _tag: 'Err', reason: 'backup-invalid' }
  }
  if (!matchesBackup({ metadataLocation: options.metadataLocation, metadata }, options))
    return { _tag: 'Err', reason: 'backup-invalid' }
  if (!await options.confirmAuthority())
    return { _tag: 'Err', reason: 'authority-changed' }
  const registered = await restCatalogRegisterTable(conn.catalog, { namespace: conn.namespace, table, metadataLocation: options.metadataLocation, overwrite: false })
    .then(value => ({ _tag: 'Acknowledged' as const, value }), (cause: unknown) => ({ _tag: 'Unknown' as const, reason: 'request-failed' as const, cause }))
  if (registered._tag === 'Unknown')
    return registered
  if (!matchesBackup({ metadataLocation: registered.value.metadataLocation, metadata: registered.value.metadata }, options))
    return { _tag: 'Unknown', reason: 'acknowledgement-invalid' }
  if (!await options.confirmAuthority())
    return { _tag: 'Unknown', reason: 'authority-changed' }
  if (options.cache)
    await invalidateSnapshotRef(options.cache, conn.namespace, table, conn.cacheScope)
  return { _tag: 'Restored', tableUuid: options.tableUuid, snapshotIds: [...options.snapshotIds] }
}
