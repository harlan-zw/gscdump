/**
 * Unit tests for the pure routing + LRU logic of `useGscSnapshotAnalyzer`.
 *
 * The composable itself depends on Nuxt auto-imports and the real DuckDB-WASM
 * + OPFS path — that needs a browser (see the task report's "real-browser
 * test" note). The routing decision and result LRU are extracted into a
 * Nuxt-free module precisely so they CAN be unit-tested here.
 */

import type { ArchetypeQuery } from '@gscdump/sdk'
import type { AnalyzerTableRouting } from '../app/composables/useGscSnapshotAnalyzer.contract'
import { describe, expect, it } from 'vitest'
import {
  archetypeQueryHash,
  createResultLru,
  resultCacheKey,
  routeArchetype,
} from '../app/composables/useGscSnapshotAnalyzer.routing'

const range = { start: '2026-01-01', end: '2026-03-31' }

// Stand-in for the engine's `tableForArchetype` — maps an archetype to its
// fact table without importing the DuckDB-WASM engine into a Nuxt test.
function tableOf(q: ArchetypeQuery): string | null {
  if (q.archetype === 'aux-cloud-only')
    return null
  if (q.archetype === 'two-dimension-detail')
    return 'page_keywords'
  if (q.archetype === 'site-daily-timeseries')
    return 'pages'
  if (q.archetype === 'multi-series-stacked-daily')
    return (q as { seriesDimension: string }).seriesDimension === 'device' ? 'devices' : 'countries'
  return 'keywords'
}

describe('routeArchetype', () => {
  const siteTs: ArchetypeQuery = {
    archetype: 'site-daily-timeseries',
    siteId: 's1',
    searchType: 'web',
    range,
    metrics: ['clicks'],
  }
  const whale: ArchetypeQuery = {
    archetype: 'two-dimension-detail',
    siteId: 's1',
    searchType: 'web',
    range,
    metrics: ['clicks'],
  }
  const aux: ArchetypeQuery = { archetype: 'aux-cloud-only', siteId: 's1', dataset: 'sitemaps' }

  it('routes aux-cloud-only to cloud regardless of routing map', () => {
    expect(routeArchetype(aux, {}, tableOf)).toBe('cloud')
    expect(routeArchetype(aux, { page_keywords: 'browser' }, tableOf)).toBe('cloud')
  })

  it('routes a browser-eligible table locally', () => {
    const routing: AnalyzerTableRouting = { pages: 'browser', page_keywords: 'browser' }
    expect(routeArchetype(siteTs, routing, tableOf)).toBe('browser')
    expect(routeArchetype(whale, routing, tableOf)).toBe('browser')
  })

  it('routes a server-mode table (whale deep history) to the server tail', () => {
    const routing: AnalyzerTableRouting = { pages: 'browser', page_keywords: 'server' }
    expect(routeArchetype(siteTs, routing, tableOf)).toBe('browser')
    expect(routeArchetype(whale, routing, tableOf)).toBe('server')
  })

  it('fails safe to server for a table missing from the routing map', () => {
    expect(routeArchetype(whale, {}, tableOf)).toBe('server')
  })
})

describe('archetypeQueryHash / resultCacheKey', () => {
  it('produces a stable hash insensitive to key insertion order', () => {
    const a = { archetype: 'site-daily-timeseries', siteId: 's1', searchType: 'web', range, metrics: ['clicks'] } as ArchetypeQuery
    const b = { metrics: ['clicks'], range, searchType: 'web', siteId: 's1', archetype: 'site-daily-timeseries' } as ArchetypeQuery
    expect(archetypeQueryHash(a)).toBe(archetypeQueryHash(b))
  })

  it('differs when any input differs', () => {
    const a = { archetype: 'site-daily-timeseries', siteId: 's1', searchType: 'web', range, metrics: ['clicks'] } as ArchetypeQuery
    const b = { archetype: 'site-daily-timeseries', siteId: 's2', searchType: 'web', range, metrics: ['clicks'] } as ArchetypeQuery
    expect(archetypeQueryHash(a)).not.toBe(archetypeQueryHash(b))
  })

  it('keys by snapshotVersion so a new snapshot invalidates cached results', () => {
    const q = { archetype: 'site-daily-timeseries', siteId: 's1', searchType: 'web', range, metrics: ['clicks'] } as ArchetypeQuery
    expect(resultCacheKey('v1', q)).not.toBe(resultCacheKey('v2', q))
    expect(resultCacheKey('v1', q)).toBe(resultCacheKey('v1', q))
  })

  it('tolerates an undefined snapshotVersion', () => {
    const q = { archetype: 'site-daily-timeseries', siteId: 's1', searchType: 'web', range, metrics: ['clicks'] } as ArchetypeQuery
    expect(resultCacheKey(undefined, q)).toContain('none::')
  })
})

describe('createResultLru', () => {
  it('stores and retrieves by key', () => {
    const lru = createResultLru<number>(3)
    lru.set('a', 1)
    expect(lru.get('a')).toBe(1)
    expect(lru.get('missing')).toBeUndefined()
  })

  it('evicts the least-recently-used entry past capacity', () => {
    const lru = createResultLru<number>(2)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.set('c', 3) // evicts 'a'
    expect(lru.get('a')).toBeUndefined()
    expect(lru.get('b')).toBe(2)
    expect(lru.get('c')).toBe(3)
  })

  it('a get() marks recency, protecting an entry from eviction', () => {
    const lru = createResultLru<number>(2)
    lru.set('a', 1)
    lru.set('b', 2)
    expect(lru.get('a')).toBe(1) // 'a' now most-recent
    lru.set('c', 3) // evicts 'b', not 'a'
    expect(lru.get('a')).toBe(1)
    expect(lru.get('b')).toBeUndefined()
  })

  it('overwriting a key refreshes its recency and value', () => {
    const lru = createResultLru<number>(2)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.set('a', 10) // 'a' refreshed → most-recent
    lru.set('c', 3) // evicts 'b'
    expect(lru.get('a')).toBe(10)
    expect(lru.get('b')).toBeUndefined()
  })

  it('clear empties the cache', () => {
    const lru = createResultLru<number>(3)
    lru.set('a', 1)
    lru.clear()
    expect(lru.size).toBe(0)
    expect(lru.get('a')).toBeUndefined()
  })

  it('clamps a non-positive capacity to 1', () => {
    const lru = createResultLru<number>(0)
    lru.set('a', 1)
    lru.set('b', 2)
    expect(lru.size).toBe(1)
    expect(lru.get('b')).toBe(2)
  })
})
