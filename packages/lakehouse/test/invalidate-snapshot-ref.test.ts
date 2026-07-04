// The sync-side snapshot-ref purge (gscdump.com "34min worst staleness" fix):
// writers call `invalidateSnapshotRef` post-commit so readers see the new
// snapshot on the next load instead of after SNAPSHOT_REF_TTL. The key format
// is private to catalog.ts — this test pins the exact key so a format change
// there can't silently turn the purge into a no-op deleting the wrong key.
import type { CatalogCache } from '../src/catalog-cache'
import { describe, expect, it, vi } from 'vitest'
import { invalidateSnapshotRef } from '../src/catalog'

function cacheWith(removeItem: (key: string) => Promise<void>): CatalogCache {
  return { storage: { removeItem } as unknown as CatalogCache['storage'] }
}

describe('invalidateSnapshotRef', () => {
  it('deletes exactly the snapshot-ref key loadSnapshotId reads/writes', async () => {
    const removeItem = vi.fn(async () => {})
    await invalidateSnapshotRef(cacheWith(removeItem), 'gsc', 'queries')
    expect(removeItem).toHaveBeenCalledExactlyOnceWith('lh-snapref\0gsc\0queries')
  })

  it('swallows driver errors — a failed delete must not fail the commit path', async () => {
    const removeItem = vi.fn(async () => {
      throw new Error('kv down')
    })
    await expect(invalidateSnapshotRef(cacheWith(removeItem), 'gsc', 'queries')).resolves.toBeUndefined()
  })
})
