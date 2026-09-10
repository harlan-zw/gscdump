import type { BuilderState } from 'gscdump/query'
import { between, date, gsc } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { builderStateToArchetype, extractWireDateRange } from '../src/archetype-compile'

const wireDate = { type: 'between', column: 'date', from: '2026-06-01', to: '2026-06-30' }
const malformedFilters = [
  { label: 'invalid date expression', filter: { type: 'and', filters: [{ type: 'gt', column: 'date', value: 'not-a-date' }, { type: 'lte', column: 'date', value: wireDate.to }] } },
  { label: 'null', filter: null },
  { label: 'invalid SDK leaves', filter: { _filters: 42 } },
  { label: 'empty OR', filter: { type: 'or', filters: [] } },
  { label: 'date inside OR', filter: { type: 'or', filters: [wireDate, { type: 'eq', column: 'query', value: 'nuxt' }] } },
  { label: 'unknown operator', filter: { type: 'and', filters: [wireDate, { type: 'typo', column: 'query', value: 'nuxt' }] } },
  { label: 'invalid search type', filter: { type: 'and', filters: [wireDate, { type: 'eq', column: 'searchType', value: 'typo' }] } },
]

describe('archetype parser failures', () => {
  it.each(malformedFilters)('declines $label without throwing', ({ filter }) => {
    expect(extractWireDateRange(filter)).toBeNull()
    expect(builderStateToArchetype('s_1', { dimensions: ['date'], filter } as unknown as BuilderState)).toBeNull()
  })

  it.each([
    { label: 'null state', state: null },
    { label: 'invalid dimensions', state: { dimensions: ['typo'], filter: wireDate } },
    { label: 'invalid ordering', state: { dimensions: ['page'], filter: wireDate, orderBy: { column: 'clicks', dir: 'typo' } } },
    { label: 'invalid limit', state: { dimensions: ['page'], filter: wireDate, rowLimit: -1 } },
  ])('declines $label without throwing', ({ state }) => {
    expect(builderStateToArchetype('s_1', state as unknown as BuilderState)).toBeNull()
  })

  it('declines a cyclic filter', () => {
    const filter: { _filters: unknown[], _nestedGroups: unknown[] } = { _filters: [], _nestedGroups: [] }
    filter._nestedGroups.push(filter)
    expect(extractWireDateRange(filter)).toBeNull()
    expect(builderStateToArchetype('s_1', { dimensions: ['date'], filter } as unknown as BuilderState)).toBeNull()
  })

  it('preserves valid SDK and wire date ranges', () => {
    const sdkState = gsc.select(date).where(between(date, wireDate.from, wireDate.to)).getState()
    for (const filter of [wireDate, sdkState.filter]) {
      expect(extractWireDateRange(filter)).toEqual({ start: wireDate.from, end: wireDate.to })
      expect(builderStateToArchetype('s_1', { ...sdkState, filter } as unknown as BuilderState)).toMatchObject({
        archetype: 'site-daily-timeseries',
        range: { start: wireDate.from, end: wireDate.to },
      })
    }
  })
})
