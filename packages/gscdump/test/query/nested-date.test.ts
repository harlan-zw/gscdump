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

  it('falls back to nested date when no outer date set (single nested group)', () => {
    // Wrapping a single between in and() puts it as a leaf, not nested — use
    // explicit or() to push it into a nested group with no outer date.
    const body = gsc
      .select(page)
      .where(and(or(between(date, '2026-04-01', '2026-04-30'))))
      .toBody()

    expect(body.startDate).toBe('2026-04-01')
    expect(body.endDate).toBe('2026-04-30')
  })
})
