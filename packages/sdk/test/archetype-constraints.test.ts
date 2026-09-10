import { between, clicks, date, device, gsc, gt, impressions, page, query } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { builderStateToArchetype } from '../src/archetype-compile'

const range = between(date, '2026-06-01', '2026-06-30')

describe('archetype constraint preservation', () => {
  it('preserves the builder search type and permits an explicit option override', () => {
    const state = gsc.select(date).where(range).type('discover').getState()
    expect(builderStateToArchetype('s_1', state)).toMatchObject({ searchType: 'discover' })
    expect(builderStateToArchetype('s_1', state, { searchType: 'image' })).toMatchObject({ searchType: 'image' })
  })

  it.each([
    gsc.select(page).where(range).prefilter(gt(clicks, 10)),
    gsc.select(date).where(range).dataState('all'),
    gsc.select(page).where(range).aggregationType('byPage'),
    gsc.select(date).where(range).limit(1),
    gsc.select(date).where(range).offset(3),
    gsc.select(date).where(range).orderBy(clicks, 'desc'),
    gsc.select(page, query).where(range).offset(3),
    gsc.select(page).where(range).orderBy(date, 'asc'),
  ])('declines a constraint the target archetype cannot represent', (builder) => {
    expect(builderStateToArchetype('s_1', builder.getState())).toBeNull()
  })

  it.each([
    gsc.select(date, clicks).where(range),
    gsc.select(page, clicks).where(range),
    gsc.select(page, query, clicks).where(range),
  ])('preserves explicitly selected metrics', (builder) => {
    expect(builderStateToArchetype('s_1', builder.getState())).toMatchObject({ metrics: ['clicks'] })
  })

  it('preserves one metric for stacked series and declines multiple requested metrics', () => {
    expect(builderStateToArchetype('s_1', gsc.select(date, device, impressions).where(range).getState()))
      .toMatchObject({ metric: 'impressions' })
    expect(builderStateToArchetype('s_1', gsc.select(date, device, clicks, impressions).where(range).getState())).toBeNull()
  })
})
