import { describe, expect, it } from 'vitest'
import { analysisRequestedRange, buildCoveragePlan } from '../src/analysis-range'

describe('analysisRequestedRange', () => {
  it('merges current, comparison, and builder-state date bounds', () => {
    expect(analysisRequestedRange({
      type: 'data-query',
      startDate: '2026-05-10',
      endDate: '2026-05-12',
      prevStartDate: '2026-05-01',
      prevEndDate: '2026-05-09',
      q: {
        dimensions: ['page'],
        filter: { type: 'between', column: 'date', from: '2026-04-20', to: '2026-04-21' },
      },
    } as never)).toEqual({ start: '2026-04-20', end: '2026-05-12' })
  })

  it('ignores invalid direct ranges', () => {
    expect(analysisRequestedRange({
      type: 'data-query',
      startDate: '2026-06-01',
      endDate: '2026-05-01',
    } as never)).toBeNull()
  })

  it('propagates malformed filters unless the host handles the parse failure', () => {
    const params = {
      q: {
        filter: new Proxy({}, {
          has: () => {
            throw new Error('unreadable filter')
          },
        }),
      },
    } as never

    expect(() => analysisRequestedRange(params)).toThrow('unreadable filter')
    const errors: unknown[] = []
    expect(analysisRequestedRange(params, error => errors.push(error))).toBeNull()
    expect(errors).toHaveLength(1)
  })
})

describe('buildCoveragePlan', () => {
  const reader = (byTable: Record<string, string[]>) => ({
    datesForTable: async ({ table }: { table: string }) => byTable[table] ?? [],
  })

  it('reports gaps per table and completes only when every required table covers the range', async () => {
    const plan = await buildCoveragePlan({
      searchType: 'web',
      requested: { start: '2026-05-01', end: '2026-05-05' },
      tables: ['pages', { table: 'queries', required: false }],
      reader: reader({ pages: ['2026-05-01', '2026-05-02', '2026-05-04', '2026-05-05'], queries: [] }),
    })
    expect(plan.complete).toBe(false)
    expect(plan.tables).toEqual([
      { table: 'pages', required: true, coveredSpans: [{ start: '2026-05-01', end: '2026-05-02' }, { start: '2026-05-04', end: '2026-05-05' }], gaps: [{ start: '2026-05-03', end: '2026-05-03' }] },
      { table: 'queries', required: false, coveredSpans: [], gaps: [{ start: '2026-05-01', end: '2026-05-05' }] },
    ])
  })

  it('ignores optional tables and the tail grace when judging completeness', async () => {
    const plan = await buildCoveragePlan({
      searchType: 'web',
      requested: { start: '2026-05-01', end: '2026-05-03' },
      tables: ['pages', { table: 'queries', required: false }],
      reader: reader({ pages: ['2026-05-01', '2026-05-02'] }),
      tailGraceDays: 1,
    })
    expect(plan.complete).toBe(true)
    expect(plan.tables[0]!.gaps).toEqual([{ start: '2026-05-03', end: '2026-05-03' }])
  })

  it('changes the coverage version when coverage changes', async () => {
    const build = (dates: string[]) => buildCoveragePlan({ searchType: 'web', requested: { start: '2026-05-01', end: '2026-05-02' }, tables: ['pages'], reader: reader({ pages: dates }) })
    const before = await build(['2026-05-01'])
    const after = await build(['2026-05-01', '2026-05-02'])
    expect(after.complete).toBe(true)
    expect(after.coverageVersion).not.toBe(before.coverageVersion)
  })
})
