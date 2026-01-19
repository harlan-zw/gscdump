import { describe, expect, it } from 'vitest'
import { daysAgo, today } from '../src/dates'

describe('dates', () => {
  it('today returns YYYY-MM-DD format', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('daysAgo(0) equals today', () => {
    expect(daysAgo(0)).toBe(today())
  })

  it('daysAgo returns consistent PST dates', () => {
    // daysAgo(1) should be exactly 1 day before daysAgo(0)
    const d0 = new Date(daysAgo(0))
    const d1 = new Date(daysAgo(1))
    const d30 = new Date(daysAgo(30))

    expect(Math.round((d0.getTime() - d1.getTime()) / 86400000)).toBe(1)
    expect(Math.round((d0.getTime() - d30.getTime()) / 86400000)).toBe(30)
  })
})
