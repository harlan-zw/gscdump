import type { GoogleSearchConsoleClient } from '../../src/core/client'
import { describe, expect, it, vi } from 'vitest'
import { gsc } from '../../src/query/builder'
import { country, date, device, page } from '../../src/query/columns'
import { Country, Device } from '../../src/query/constants'
import { and, between, contains, eq, gt, gte, inArray, lt, lte, regex } from '../../src/query/operators'

describe('gSCQueryBuilder', () => {
  describe('toBody', () => {
    it('builds correct query body with dimensions and between()', () => {
      const body = gsc
        .select('page', 'device')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensions).toEqual(['page', 'device'])
      expect(body.startDate).toBe('2024-01-01')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('builds correct query body with gte/lte', () => {
      const body = gsc
        .select('page')
        .where(gte(date, '2024-01-01'))
        .where(lte(date, '2024-01-31'))
        .toBody()

      expect(body.startDate).toBe('2024-01-01')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('adjusts date for gt (adds 1 day)', () => {
      const body = gsc
        .select('page')
        .where(gt(date, '2024-01-01'))
        .where(lte(date, '2024-01-31'))
        .toBody()

      expect(body.startDate).toBe('2024-01-02')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('adjusts date for lt (subtracts 1 day)', () => {
      const body = gsc
        .select('page')
        .where(gte(date, '2024-01-01'))
        .where(lt(date, '2024-02-01'))
        .toBody()

      expect(body.startDate).toBe('2024-01-01')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('builds body with single eq filter', () => {
      const body = gsc
        .select('page', 'device')
        .where(eq(device, Device.MOBILE))
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensions).toEqual(['page', 'device'])
      expect(body.dimensionFilterGroups).toBeDefined()
      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].filters).toEqual([{
        dimension: 'device',
        operator: 'equals',
        expression: 'MOBILE',
      }])
    })

    it('builds body with multiple filters using and()', () => {
      const body = gsc
        .select('page', 'device', 'country')
        .where(and(
          eq(device, Device.MOBILE),
          eq(country, Country.USA),
        ))
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].filters).toHaveLength(2)
    })

    it('builds body with inArray as OR group', () => {
      const body = gsc
        .select('country')
        .where(inArray(country, [Country.USA, Country.GBR, Country.AUS]))
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].groupType).toBe('or')
      expect(body.dimensionFilterGroups![0].filters).toHaveLength(3)
    })

    it('builds body with contains filter', () => {
      const body = gsc
        .select('page')
        .where(contains(page, '/blog/'))
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensionFilterGroups![0].filters![0]).toEqual({
        dimension: 'page',
        operator: 'contains',
        expression: '/blog/',
      })
    })

    it('builds body with regex filter', () => {
      const body = gsc
        .select('page')
        .where(regex(page, '^/blog/2024'))
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensionFilterGroups![0].filters![0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '^/blog/2024',
      })
    })

    it('sets rowLimit', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .limit(100)
        .toBody()

      expect(body.rowLimit).toBe(100)
    })

    it('does not include dimensionFilterGroups when only date filter', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensionFilterGroups).toBeUndefined()
    })

    it('throws when no date range set', () => {
      expect(() => gsc.select('page').toBody()).toThrow('Date range required')
    })
  })

  describe('chaining', () => {
    it('allows multiple where clauses', () => {
      const body = gsc
        .select('page', 'device')
        .where(eq(device, Device.MOBILE))
        .where(contains(page, '/blog/'))
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensionFilterGroups).toHaveLength(2)
    })

    it('allows chaining in any order', () => {
      const body = gsc
        .limit(50)
        .siteUrl('https://example.com')
        .select('page', 'query')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .where(eq(device, Device.DESKTOP))
        .toBody()

      expect(body.dimensions).toEqual(['page', 'query'])
      expect(body.rowLimit).toBe(50)
      expect(body.dimensionFilterGroups).toBeDefined()
    })
  })

  describe('execute', () => {
    it('calls client.searchAnalytics.query with correct args', async () => {
      const mockClient: GoogleSearchConsoleClient = {
        sites: { list: vi.fn() },
        sitemaps: {
          list: vi.fn(),
          get: vi.fn(),
          submit: vi.fn(),
          delete: vi.fn(),
        },
        searchAnalytics: {
          query: vi.fn().mockResolvedValue({
            rows: [
              { keys: ['/page1', 'MOBILE'], clicks: 100, impressions: 1000, ctr: 0.1, position: 5.5 },
              { keys: ['/page2', 'MOBILE'], clicks: 50, impressions: 500, ctr: 0.1, position: 3.2 },
            ],
          }),
        },
        urlInspection: { inspect: vi.fn() },
        indexing: { publish: vi.fn(), getMetadata: vi.fn() },
      }

      const result = await gsc
        .select('page', 'device')
        .where(eq(device, Device.MOBILE))
        .where(between(date, '2024-01-01', '2024-01-31'))
        .siteUrl('https://example.com')
        .execute(mockClient)

      expect(mockClient.searchAnalytics.query).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          dimensions: ['page', 'device'],
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        }),
      )

      expect(result.rows).toHaveLength(2)
      expect(result.rows[0]).toEqual({
        page: '/page1',
        device: 'MOBILE',
        clicks: 100,
        impressions: 1000,
        ctr: 0.1,
        position: 5.5,
      })
    })

    it('handles empty response', async () => {
      const mockClient: GoogleSearchConsoleClient = {
        sites: { list: vi.fn() },
        sitemaps: {
          list: vi.fn(),
          get: vi.fn(),
          submit: vi.fn(),
          delete: vi.fn(),
        },
        searchAnalytics: {
          query: vi.fn().mockResolvedValue({}),
        },
        urlInspection: { inspect: vi.fn() },
        indexing: { publish: vi.fn(), getMetadata: vi.fn() },
      }

      const result = await gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .siteUrl('https://example.com')
        .execute(mockClient)

      expect(result.rows).toEqual([])
    })
  })
})
