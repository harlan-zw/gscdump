/**
 * Contract tests for `createCompositeSource`. Locks in:
 *   - seam reports `kind: 'composite'` (not engine's kind via spread)
 *   - capabilities, adapter, siteId come from engine
 *   - queryRows routes via `shouldRouteToLive`
 *   - executeSql passes through to engine (omitted if engine has none)
 */

import type { AnalysisQuerySource, SourceCapabilities } from '@gscdump/engine/source'
import { between, date, gsc, page } from 'gscdump/query'
import { describe, expect, it, vi } from 'vitest'

import { createCompositeSource, shouldRouteToLive } from '../src/source/composite'

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
})
