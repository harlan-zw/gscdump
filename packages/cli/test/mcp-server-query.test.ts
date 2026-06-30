import { describe, expect, it, vi } from 'vitest'
import { runMcpSearchAnalyticsQuery } from '../src/mcp/server'

function row(key: string) {
  return { keys: [key], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }
}

describe('runMcpSearchAnalyticsQuery', () => {
  it('continues after short non-empty pages until the total rowLimit is reached', async () => {
    const rawQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [row('a')] })
      .mockResolvedValueOnce({ rows: [row('b')] })

    const result = await runMcpSearchAnalyticsQuery({ _rawQuery: rawQuery } as any, {
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-05-01',
      endDate: '2026-05-07',
      dimensions: ['query'],
      rowLimit: 2,
    })

    expect(result.rowCount).toBe(2)
    expect(result.rows.map(value => value.query)).toEqual(['a', 'b'])
    expect(rawQuery).toHaveBeenCalledTimes(2)
    expect(rawQuery.mock.calls[0]![1]).toMatchObject({ rowLimit: 2, startRow: 0 })
    expect(rawQuery.mock.calls[1]![1]).toMatchObject({ rowLimit: 1, startRow: 1 })
  })

  it('stops on an empty page', async () => {
    const rawQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [row('a')] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await runMcpSearchAnalyticsQuery({ _rawQuery: rawQuery } as any, {
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-05-01',
      endDate: '2026-05-07',
      dimensions: ['query'],
      rowLimit: 10,
    })

    expect(result.rowCount).toBe(1)
    expect(rawQuery).toHaveBeenCalledTimes(2)
    expect(rawQuery.mock.calls[1]![1]).toMatchObject({ rowLimit: 9, startRow: 1 })
  })
})
