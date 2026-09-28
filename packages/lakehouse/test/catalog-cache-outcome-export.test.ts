/**
 * Public surface contract for the cache read outcome: the exported
 * `cacheGet` callback parameter type must be nameable by consumers through
 * the package index, matching the type used by the implementation.
 */

import type { CatalogCache, CatalogCacheGetOutcome } from '../src/index'
import { createStorage } from 'unstorage'
import { describe, expect, it } from 'vitest'
import { cacheGet, cachePut } from '../src/index'

describe('public cacheGet outcome surface', () => {
  it('reports read outcomes to a typed callback through the package index', async () => {
    const cache: CatalogCache = { storage: createStorage() }
    const seen: CatalogCacheGetOutcome[] = []
    const onOutcome = (outcome: CatalogCacheGetOutcome): void => {
      seen.push(outcome)
    }

    const missed = await cacheGet<string>(cache, 'gsc:config', 1_000, onOutcome)
    expect(missed).toBeUndefined()

    await cachePut(cache, 'gsc:config', 'catalog-config', 60_000, 1_000)
    const hit = await cacheGet<string>(cache, 'gsc:config', 2_000, onOutcome)
    expect(hit).toBe('catalog-config')
    expect(seen).toEqual(['miss', 'hit'])
  })
})
