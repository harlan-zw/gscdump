/**
 * Regression test for the cross-mount slot misalignment bug (harlan-zw/gscdump#44
 * review): `cacheGetMany` first matched `getItems` results to input keys by raw
 * index, then by raw-spelling key echo. Both fail in production: unstorage
 * flattens one batch per mount in mount order (indices only line up within a
 * single mount), and it echoes each entry's `normalizeKey` — slashes and query
 * strings rewritten — so a real key like `lh-manifest\0scope\0s3://bucket/...`
 * never round-trips to its input spelling. Slots must be matched by the
 * normalized key form instead.
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

/** Keys shaped like `manifestCacheKey()` output, prefixed for each mount. */
function manifestKey(mount: string, uuid: string): string {
  return `${mount}:lh-manifest\0team\0s3://bucket/gsc/queries/metadata/${uuid}-m0.avro`
}

describe('cacheGetMany', () => {
  it('matches each slot to its own key when manifest-shaped keys alternate across two mounts', async () => {
    const cache = { storage: twoMountStorage() }

    const a1 = manifestKey('mount-a', 'aaaa-1111')
    const b1 = manifestKey('mount-b', 'bbbb-2222')
    const a2 = manifestKey('mount-a', 'cccc-3333')
    const b2 = manifestKey('mount-b', 'dddd-4444')

    await cachePut(cache, a1, 'a-1111', TTL, NOW)
    await cachePut(cache, b1, 'b-2222', TTL, NOW)
    await cachePut(cache, a2, 'a-3333', TTL, NOW)
    await cachePut(cache, b2, 'b-4444', TTL, NOW)

    const values = await cacheGetMany<string>(cache, [a1, b1, a2, b2], NOW + 1)

    expect(values).toEqual(['a-1111', 'b-2222', 'a-3333', 'b-4444'])
  })

  it('still returns undefined per slot for misses and expired entries', async () => {
    const cache = { storage: twoMountStorage() }

    const live = manifestKey('mount-a', 'aaaa-1111')
    const missing = manifestKey('mount-b', 'bbbb-2222')
    const expired = manifestKey('mount-b', 'cccc-3333')

    await cachePut(cache, live, 'a-live', TTL, NOW)
    await cachePut(cache, expired, 'b-expired', 1_000, NOW)

    const values = await cacheGetMany<string>(cache, [live, missing, expired], NOW + 2_000)

    expect(values).toEqual(['a-live', undefined, undefined])
  })
})
