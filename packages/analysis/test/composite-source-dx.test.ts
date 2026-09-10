import type { AnalysisQuerySource } from '@gscdump/engine/source'
import { and, between, date, eq, gsc, query, queryCanonical } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { createCompositeSource } from '../src/source'

function source(rows: Record<string, unknown>[]): AnalysisQuerySource {
  return { capabilities: {}, queryRows: async () => rows }
}

describe('composite Source coverage and filters', () => {
  it('uses live rows when explicit coverage is empty', async () => {
    const liveRows = [{ query: 'live', clicks: 3 }]
    const composite = createCompositeSource({
      engine: source([]),
      live: source(liveRows),
      site: { oldestDateSynced: '2026-06-01', newestDateSynced: '2026-06-30', coveredSpans: [] },
    })
    const state = gsc.select(query).where(between(date, '2026-06-01', '2026-06-30')).getState()
    await expect(composite.queryRows(state)).resolves.toEqual(liveRows)
  })

  it('keeps Engine-derived filters on the Engine outside its synced range', async () => {
    const engineRows = [{ query: 'raw', clicks: 3 }]
    const composite = createCompositeSource({
      engine: source(engineRows),
      live: { capabilities: {}, queryRows: async () => { throw new Error('live does not support queryCanonical') } },
      site: { oldestDateSynced: '2026-06-01', newestDateSynced: '2026-06-30' },
    })
    const state = gsc.select(query).where(and(
      between(date, '2026-05-01', '2026-05-31'),
      eq(queryCanonical, 'canonical'),
    )).getState()
    await expect(composite.queryRows(state)).resolves.toEqual(engineRows)
  })
})
