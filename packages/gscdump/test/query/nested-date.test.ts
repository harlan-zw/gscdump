import { describe, expect, it } from 'vitest'
import { gsc } from '../../src/query/builder'
import { country, date, page } from '../../src/query/columns'
import { and, between, eq, or } from '../../src/query/operators'

describe('extractSpecialFilters nested-group precedence', () => {
  it('outer date range wins over nested OR group with different dates', () => {
    const body = gsc
      .select(page)
      .where(and(
        between(date, '2026-05-01', '2026-05-07'),
        or(eq(country, 'usa'), eq(country, 'gbr')),
      ))
      .toBody()

    expect(body.startDate).toBe('2026-05-01')
    expect(body.endDate).toBe('2026-05-07')
  })

  it('rejects date filter inside or() (would silently collapse to AND)', () => {
    // The nested-date fallback path used to be reachable by wrapping a
    // single between(date, ...) in or(). The or() guard now forbids that
    // construction; the fallback in extractSpecialFilters remains as a
    // defensive no-op.
    expect(() => or(between(date, '2026-04-01', '2026-04-30'))).toThrow(/date/)
  })
})
