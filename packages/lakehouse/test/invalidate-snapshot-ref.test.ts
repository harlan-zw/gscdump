// The sync-side snapshot-ref purge (gscdump.com "34min worst staleness" fix):
// writers call `invalidateSnapshotRef` post-commit so readers see the new
// snapshot on the next load instead of after SNAPSHOT_REF_TTL. The key format
// is private to catalog.ts — this test pins the exact key so a format change
// there can't silently turn the purge into a no-op deleting the wrong key.
import type { CatalogCache } from '../src/catalog-cache'
import { describe, expect, it, vi } from 'vitest'
import { invalidateSnapshotRef } from '../src/catalog'

function cacheWith(removeItem: (key: string) => Promise<void>, onError?: CatalogCache['onError']): CatalogCache {
  return { storage: { removeItem } as unknown as CatalogCache['storage'], onError }
}

describe('invalidateSnapshotRef', () => {
  it('deletes exactly the snapshot-ref key loadSnapshotId reads/writes', async () => {
    const removeItem = vi.fn(async () => {})
    await invalidateSnapshotRef(cacheWith(removeItem), 'gsc', 'queries')
    expect(removeItem).toHaveBeenCalledExactlyOnceWith('lh-snapref\0\0gsc\0queries')
  })

  it('scopes the key by catalog identity when a cacheScope is given', async () => {
    const removeItem = vi.fn(async () => {})
    await invalidateSnapshotRef(cacheWith(removeItem), 'gsc', 'queries', 'https://cat\0team-7-int')
    expect(removeItem).toHaveBeenCalledExactlyOnceWith('lh-snapref\0https://cat\0team-7-int\0gsc\0queries')
  })

  it('reports driver errors without failing the commit path', async () => {
    const onError = vi.fn()
    const failure = new Error('kv down')
    const removeItem = vi.fn(async () => {
      throw failure
    })
    await expect(invalidateSnapshotRef(cacheWith(removeItem, onError), 'gsc', 'queries')).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledExactlyOnceWith('remove', 'lh-snapref\0\0gsc\0queries', failure)
  })
})
