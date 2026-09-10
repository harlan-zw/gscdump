/**
 * Contract tests for `createCompositeSource`. Locks in:
 *   - seam reports `kind: 'composite'` (not engine's kind via spread)
 *   - capabilities, adapter, siteId come from engine
 *   - queryRows routes via `shouldRouteToLive`
 *   - executeSql passes through to engine (omitted if engine has none)
 */

import type { AnalysisQuerySource, SourceCapabilities } from '@gscdump/engine/source'
import { and, between, clicks, date, device, eq, gsc, gte, page, query } from 'gscdump/query'
import { describe, expect, it, vi } from 'vitest'

import { createCompositeSource, hasGapInCoveredSpans, shouldRouteToLive } from '../src/source/composite'

function makeSource(over: Partial<AnalysisQuerySource> = {}): AnalysisQuerySource {
  const caps: SourceCapabilities = { regex: true, ...(over.capabilities ?? {}) }
  return {
    name: 'fake',
    kind: 'local',
    capabilities: caps,
    queryRows: vi.fn(async () => [] as any[]),
    ...over,
  }
}

function stateInRange(start: string, end: string) {
  return gsc.select(page).where(between(date, start, end)).limit(100).getState()
}

describe('createCompositeSource', () => {
  it('reports kind composite, not engine kind', () => {
    const engine = makeSource({ kind: 'local' })
    const live = makeSource({ kind: 'live' })
    const c = createCompositeSource({
      engine,
      live,
      site: { oldestDateSynced: '2024-01-01', newestDateSynced: '2024-12-31' },
    })
    expect(c.kind).toBe('composite')
    expect(c.name).toBe('composite-engine-live')
  })

  it('inherits capabilities, adapter, siteId from engine only', () => {
    const adapter = { capabilities: {}, columnFor: () => null, tableFor: () => null } as any
    const engine = makeSource({ capabilities: { regex: true, executeSql: true } as any, adapter, siteId: 'site-a' })
    const live = makeSource({ capabilities: { regex: false } as any, adapter: { foo: 'live' } as any, siteId: 'should-not-leak' })
    const c = createCompositeSource({ engine, live, site: { oldestDateSynced: null, newestDateSynced: null } })
    expect(c.capabilities).toBe(engine.capabilities)
    expect(c.adapter).toBe(adapter)
    expect(c.siteId).toBe('site-a')
  })

  it('routes queryRows to engine for in-range queries', async () => {
    const engine = makeSource()
    const live = makeSource()
    const c = createCompositeSource({
      engine,
      live,
      site: { oldestDateSynced: '2024-01-01', newestDateSynced: '2024-12-31' },
    })
    await c.queryRows(stateInRange('2024-02-01', '2024-02-28'))
    expect(engine.queryRows).toHaveBeenCalledTimes(1)
    expect(live.queryRows).not.toHaveBeenCalled()
  })

  it('routes queryRows to live for out-of-range queries the API can answer', async () => {
    const engine = makeSource()
    const live = makeSource()
    const c = createCompositeSource({
      engine,
      live,
      site: { oldestDateSynced: '2024-06-01', newestDateSynced: '2024-12-31' },
    })
    await c.queryRows(stateInRange('2024-01-01', '2024-01-31'))
    expect(live.queryRows).toHaveBeenCalledTimes(1)
    expect(engine.queryRows).not.toHaveBeenCalled()
  })

  it('routes out-of-range metric-filtered queries to live', async () => {
    const engine = makeSource()
    const live = makeSource()
    const c = createCompositeSource({
      engine,
      live,
      site: { oldestDateSynced: null, newestDateSynced: null },
    })
    const state = gsc
      .select(page)
      .where(and(
        between(date, '2024-01-01', '2024-01-31'),
        gte(clicks, 10),
      ))
      .getState()

    await c.queryRows(state)

    expect(live.queryRows).toHaveBeenCalledTimes(1)
    expect(engine.queryRows).not.toHaveBeenCalled()
  })

  it('classifies a partner wire filter state instead of crashing', async () => {
    const engine = makeSource()
    const live = makeSource()
    const c = createCompositeSource({
      engine,
      live,
      site: { oldestDateSynced: '2024-01-01', newestDateSynced: '2024-12-31' },
    })
    // Partner wire filter shape: { type, filters: [{ type, column, ... }] }, no _filters key.
    const wireState = {
      dimensions: ['query'],
      filter: {
        type: 'and',
        filters: [
          { type: 'between', column: 'date', from: '2024-06-01', to: '2024-06-30' },
          { type: 'eq', column: 'queryCanonical', value: 'x' },
        ],
      },
      rowLimit: 100,
    } as any

    await expect(c.queryRows(wireState)).resolves.toEqual([])
    expect(engine.queryRows).toHaveBeenCalledTimes(1)
    expect(live.queryRows).not.toHaveBeenCalled()
  })

  it('exposes executeSql when engine has one; omits otherwise', async () => {
    const executeSql = vi.fn(async () => [{ x: 1 }] as any[])
    const engine = makeSource({ executeSql: executeSql as any })
    const live = makeSource()
    const c = createCompositeSource({ engine, live, site: { oldestDateSynced: null, newestDateSynced: null } })
    expect(typeof c.executeSql).toBe('function')
    await c.executeSql!('select 1', [])
    expect(executeSql).toHaveBeenCalledWith('select 1', [], undefined)

    const engineNoSql = makeSource()
    const c2 = createCompositeSource({ engine: engineNoSql, live, site: { oldestDateSynced: null, newestDateSynced: null } })
    expect(c2.executeSql).toBeUndefined()
  })

  it('exports shouldRouteToLive for telemetry introspection', () => {
    const s = stateInRange('2023-01-01', '2023-01-31')
    expect(shouldRouteToLive(s, { oldestDateSynced: '2024-01-01', newestDateSynced: '2024-12-31' })).toBe(true)
    expect(shouldRouteToLive(s, { oldestDateSynced: '2022-01-01', newestDateSynced: '2024-12-31' })).toBe(false)
  })

  it('routes a cross-dimension query to live even when the range is fully synced', async () => {
    // group by `query`, filter by `device` — no stored table carries both.
    const crossDim = gsc
      .select(query)
      .where(and(between(date, '2024-06-01', '2024-06-30'), eq(device, 'MOBILE')))
      .limit(100)
      .getState()
    const syncedSite = { oldestDateSynced: '2024-01-01', newestDateSynced: '2024-12-31' }
    expect(shouldRouteToLive(crossDim, syncedSite)).toBe(true)

    const engine = makeSource()
    const live = makeSource()
    const c = createCompositeSource({ engine, live, site: syncedSite })
    await c.queryRows(crossDim)
    expect(live.queryRows).toHaveBeenCalledTimes(1)
    expect(engine.queryRows).not.toHaveBeenCalled()
  })

  it('keeps a single-dimension query (its own filter) on the engine', () => {
    const sameDim = gsc
      .select(query)
      .where(and(between(date, '2024-06-01', '2024-06-30'), eq(query, 'seo')))
      .limit(100)
      .getState()
    expect(shouldRouteToLive(sameDim, { oldestDateSynced: '2024-01-01', newestDateSynced: '2024-12-31' })).toBe(false)
  })

  describe('coveredSpans gap detection', () => {
    it('routes to live when request overlaps an internal manifest gap', async () => {
      const engine = makeSource()
      const live = makeSource()
      const c = createCompositeSource({
        engine,
        live,
        site: {
          oldestDateSynced: '2024-01-01',
          newestDateSynced: '2024-12-31',
          // Gap: 2024-04 through 2024-06 missing
          coveredSpans: [
            { start: '2024-01-01', end: '2024-03-31' },
            { start: '2024-07-01', end: '2024-12-31' },
          ],
        },
      })
      await c.queryRows(stateInRange('2024-02-01', '2024-08-31'))
      expect(live.queryRows).toHaveBeenCalledTimes(1)
      expect(engine.queryRows).not.toHaveBeenCalled()
    })

    it('stays on engine when request sits inside a single span', async () => {
      const engine = makeSource()
      const live = makeSource()
      const c = createCompositeSource({
        engine,
        live,
        site: {
          oldestDateSynced: '2024-01-01',
          newestDateSynced: '2024-12-31',
          coveredSpans: [
            { start: '2024-01-01', end: '2024-03-31' },
            { start: '2024-07-01', end: '2024-12-31' },
          ],
        },
      })
      await c.queryRows(stateInRange('2024-02-01', '2024-03-15'))
      expect(engine.queryRows).toHaveBeenCalledTimes(1)
      expect(live.queryRows).not.toHaveBeenCalled()
    })

    it('hasGapInCoveredSpans handles edge cases', () => {
      const spans = [
        { start: '2024-01-01', end: '2024-03-31' },
        { start: '2024-07-01', end: '2024-12-31' },
      ]
      // Fully inside first span
      expect(hasGapInCoveredSpans('2024-01-10', '2024-03-15', spans)).toBe(false)
      // Spans two coverage ranges with gap in middle
      expect(hasGapInCoveredSpans('2024-03-01', '2024-07-15', spans)).toBe(true)
      // Adjacent days (no gap)
      expect(hasGapInCoveredSpans('2024-03-31', '2024-04-01', [
        { start: '2024-01-01', end: '2024-03-31' },
        { start: '2024-04-01', end: '2024-04-30' },
      ])).toBe(false)
      // Single day in gap
      expect(hasGapInCoveredSpans('2024-04-15', '2024-04-15', spans)).toBe(true)
      // Empty spans — everything is a gap
      expect(hasGapInCoveredSpans('2024-04-15', '2024-04-15', [])).toBe(true)
    })
  })
})
