import { describe, expect, it } from 'vitest'
import { hostedReportRequest } from '../src/hosted-report'

describe('hosted report arguments', () => {
  it('preserves the caller findings cap and movers threshold', () => {
    expect(hostedReportRequest('movers', { 'max-findings': '1', 'min-clicks-change': '3', 'period': '28d' })).toMatchObject({ reportId: 'movers', maxFindings: 1, minClicksChange: 3, period: 'last-28d' })
  })
})
