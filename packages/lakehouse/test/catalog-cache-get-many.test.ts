/**
 * Regression test for the cross-mount slot misalignment bug (harlan-zw/gscdump#44
 * review): `cacheGetMany` matched `getItems` results to input keys by index,
 * but unstorage executes a multi-key read as one batch per mount and flattens
 * the batches in mount order. When the input keys span two mounts, the
 * flattened order is mount-group order, so a positional mapping hands one
 * key's cached value to another key's slot. Slots must follow each entry's
 * echoed key instead.
 */

import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, expect, it } from 'vitest'
import { cacheGetMany, cachePut } from '../src/catalog-cache'

const NOW = 1_000
const TTL = 60_000

function twoMountStorage() {
  const storage = createStorage()
  storage.mount('mount-a', memoryDriver())
  storage.mount('mount-b', memoryDriver())
  return storage
}

describe('cacheGetMany', () => {
  it('matches each slot to its own key when keys alternate across two mounts', async () => {
    const cache = { storage: twoMountStorage() }

    await cachePut(cache, 'mount-a:one', 'a-one', TTL, NOW)
    await cachePut(cache, 'mount-b:one', 'b-one', TTL, NOW)
    await cachePut(cache, 'mount-a:two', 'a-two', TTL, NOW)
    await cachePut(cache, 'mount-b:two', 'b-two', TTL, NOW)

    const values = await cacheGetMany<string>(
      cache,
      ['mount-a:one', 'mount-b:one', 'mount-a:two', 'mount-b:two'],
      NOW + 1,
    )

    expect(values).toEqual(['a-one', 'b-one', 'a-two', 'b-two'])
  })

  it('still returns undefined per slot for misses and expired entries', async () => {
    const cache = { storage: twoMountStorage() }

    await cachePut(cache, 'mount-a:live', 'a-live', TTL, NOW)
    await cachePut(cache, 'mount-b:expired', 'b-expired', 1_000, NOW)

    const values = await cacheGetMany<string>(
      cache,
      ['mount-a:live', 'mount-b:missing', 'mount-b:expired'],
      NOW + 2_000,
    )

    expect(values).toEqual(['a-live', undefined, undefined])
  })
})
