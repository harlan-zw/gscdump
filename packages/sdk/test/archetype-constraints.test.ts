import { builderStateToArchetype } from '@gscdump/sdk/archetype'
import { and, between, clicks, date, device, eq, gsc, gt, impressions, page, query } from 'gscdump/query'
import { describe, expect, it } from 'vitest'

const range = between(date, '2026-06-01', '2026-06-30')

describe('archetype constraint preservation', () => {
  it.each([
    { builder: gsc.select(date, clicks).where(range), archetype: 'site-daily-timeseries' },
    { builder: gsc.select(date, clicks).where(and(range, eq(page, '/guide'))), archetype: 'entity-daily-timeseries' },
    { builder: gsc.select(date, clicks).where(and(range, eq(query, 'nuxt seo'))), archetype: 'entity-daily-timeseries' },
    { builder: gsc.select(date, device, clicks).where(range), archetype: 'multi-series-stacked-daily' },
    { builder: gsc.select(date, query, clicks).where(range), archetype: 'multi-series-stacked-daily' },
  ])('uses the native ascending date order for $archetype', ({ builder, archetype }) => {
    const result = builderStateToArchetype('s_1', builder.orderBy(date, 'asc').getState())
    expect(result).toMatchObject({
      archetype,
      siteId: 's_1',
      range: { start: '2026-06-01', end: '2026-06-30' },
      ...(archetype === 'multi-series-stacked-daily' ? { metric: 'clicks' } : { metrics: ['clicks'] }),
    })
  })

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
    gsc.select(date).where(range).orderBy(date, 'desc'),
    gsc.select(date).where(and(range, eq(page, '/guide'))).orderBy(date, 'desc'),
    gsc.select(date, device, clicks).where(range).orderBy(date, 'desc'),
    gsc.select(date).where(range).orderBy(date, 'asc').limit(1),
    gsc.select(date).where(range).orderBy(date, 'asc').offset(3),
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
