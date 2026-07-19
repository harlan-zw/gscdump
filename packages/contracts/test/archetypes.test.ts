import { describe, expect, it } from 'vitest'
import {
  arbitrarySql,
  entityDailyTimeseries,
  siteDailyTimeseries,
  topNBreakdown,
  twoDimensionDetail,
} from '../src/archetypes'

const range = { start: '2026-06-01', end: '2026-06-30' }
const compareRange = { start: '2026-05-01', end: '2026-05-31' }

describe('archetype constructors', () => {
  it('builds canonical defaults without sharing mutable caller arrays', () => {
    const query = siteDailyTimeseries('site-1', range)
    expect(query).toMatchObject({
      archetype: 'site-daily-timeseries',
      siteId: 'site-1',
      searchType: 'web',
      range,
      metrics: ['clicks', 'impressions', 'ctr', 'position'],
    })
  })

  it('preserves comparison, facets, movers, and canonical-query entities', () => {
    expect(entityDailyTimeseries(
      'site-1',
      range,
      { dimension: 'queryCanonical', value: 'running shoes' },
      { compareRange },
    )).toMatchObject({ compareRange, entity: { dimension: 'queryCanonical', value: 'running shoes' } })

    expect(topNBreakdown('site-1', range, 'page', {
      compareRange,
      facets: [{ column: 'country', op: 'eq', value: 'aus' }],
      includeTotal: true,
      movers: 'improving',
    })).toMatchObject({ compareRange, includeTotal: true, movers: 'improving' })
  })

  it('supports detail facets and the SQL cacheable extension', () => {
    expect(twoDimensionDetail('site-1', range, {
      facets: [{ column: 'device', op: 'eq', value: 'mobile' }],
    }).facets).toEqual([{ column: 'device', op: 'eq', value: 'mobile' }])
    expect(arbitrarySql('site-1', range, 'SELECT 1', { cacheable: true }).cacheable).toBe(true)
  })
})
