import { describe, expect, it } from 'vitest'
import { country, date, device, page, query } from '../../src/query/columns'
import { Countries, Devices } from '../../src/query/constants'
import { and, between, contains, eq, inArray, like, ne, not, notRegex, or, regex } from '../../src/query/operators'

describe('operators', () => {
  describe('eq', () => {
    it('creates equals filter for device', () => {
      const f = eq(device, Devices.MOBILE)
      expect(f._filters[0]).toEqual({
        dimension: 'device',
        operator: 'equals',
        expression: 'MOBILE',
      })
    })

    it('creates equals filter for country', () => {
      const f = eq(country, Countries.USA)
      expect(f._filters[0]).toEqual({
        dimension: 'country',
        operator: 'equals',
        expression: 'usa',
      })
    })

    it('creates equals filter for page', () => {
      const f = eq(page, '/blog/test')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'equals',
        expression: '/blog/test',
      })
    })
  })

  describe('ne', () => {
    it('creates notEquals filter', () => {
      const f = ne(device, Devices.TABLET)
      expect(f._filters[0]).toEqual({
        dimension: 'device',
        operator: 'notEquals',
        expression: 'TABLET',
      })
    })
  })

  describe('inArray', () => {
    it('creates OR group for multiple values', () => {
      const f = inArray(country, [Countries.USA, Countries.GBR])
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('or')
      expect(f._filters[0]).toEqual({
        dimension: 'country',
        operator: 'equals',
        expression: 'usa',
      })
      expect(f._filters[1]).toEqual({
        dimension: 'country',
        operator: 'equals',
        expression: 'gbr',
      })
    })

    it('works with devices', () => {
      const f = inArray(device, [Devices.MOBILE, Devices.DESKTOP])
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('or')
    })

    it('throws on empty array (would silently match everything)', () => {
      expect(() => inArray(country, [])).toThrow(/at least one value/)
    })
  })

  describe('contains', () => {
    it('creates contains filter', () => {
      const f = contains(page, '/blog/')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'contains',
        expression: '/blog/',
      })
    })
  })

  describe('like', () => {
    it('converts SQL LIKE wildcards to regex', () => {
      const f = like(page, '%/blog/%')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '.*/blog/.*',
      })
    })

    it('translates _ to single-char regex', () => {
      const f = like(page, '/post/_/end')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '/post/./end',
      })
    })

    it('falls back to contains when no wildcards present', () => {
      const f = like(query, 'test')
      expect(f._filters[0]).toEqual({
        dimension: 'query',
        operator: 'contains',
        expression: 'test',
      })
    })

    it('escapes regex metacharacters in literal portions', () => {
      const f = like(page, 'foo.bar%')
      expect(f._filters[0].expression).toBe('foo\\.bar.*')
    })
  })

  describe('regex', () => {
    it('creates includingRegex filter from string', () => {
      const f = regex(page, '^/blog/2024')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '^/blog/2024',
      })
    })

    it('creates includingRegex filter from RegExp', () => {
      const f = regex(page, /^\/blog\/\d+/)
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '^\\/blog\\/\\d+',
      })
    })
  })

  describe('notRegex', () => {
    it('creates excludingRegex filter', () => {
      const f = notRegex(page, '^/admin')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'excludingRegex',
        expression: '^/admin',
      })
    })
  })

  describe('and', () => {
    it('merges filters from multiple filters', () => {
      const f = and(
        eq(device, Devices.MOBILE),
        eq(country, Countries.USA),
      )
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('and')
    })

    it('handles nested filters', () => {
      const f = and(
        eq(device, Devices.MOBILE),
        contains(page, '/blog/'),
        eq(country, Countries.GBR),
      )
      expect(f._filters).toHaveLength(3)
    })
  })

  describe('or', () => {
    it('creates OR group', () => {
      const f = or(
        eq(device, Devices.MOBILE),
        eq(device, Devices.TABLET),
      )
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('or')
    })

    it('rejects date filters (would silently collapse to AND)', () => {
      expect(() => or(
        between(date, '2024-01-01', '2024-01-31'),
        eq(query, 'foo'),
      )).toThrow(/date/)
    })
  })

  describe('not', () => {
    it('inverts equals to notEquals', () => {
      const original = eq(device, Devices.MOBILE)
      const inverted = not(original)
      expect(inverted._filters[0].operator).toBe('notEquals')
    })

    it('inverts contains to notContains', () => {
      const original = contains(page, '/blog/')
      const inverted = not(original)
      expect(inverted._filters[0].operator).toBe('notContains')
    })

    it('inverts includingRegex to excludingRegex', () => {
      const original = regex(page, '^/blog')
      const inverted = not(original)
      expect(inverted._filters[0].operator).toBe('excludingRegex')
    })

    it('double negation restores original operator', () => {
      const original = eq(device, Devices.MOBILE)
      const doubleInverted = not(not(original))
      expect(doubleInverted._filters[0].operator).toBe('equals')
    })
  })
})
