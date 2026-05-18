import { describe, expect, it, vi } from 'vitest'
import { googleSearchConsole } from '../../src'
import { gsc } from '../../src/query/builder'
import { date, page } from '../../src/query/columns'
import { between } from '../../src/query/operators'

function fixtureRows(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    keys: [`/p${offset + i}`],
    clicks: 1,
    impressions: 10,
    ctr: 0.1,
    position: 1,
  }))
}

describe('client.query pagination', () => {
  const range = between(date, '2026-05-01', '2026-05-07')

  it('caps total rows by builder .limit(n) and stops paging', async () => {
    // Mock returns full pages forever; loop should stop at the cap.
    const mockFetch = vi.fn().mockImplementation((_url, opts) => {
      const rowLimit = opts.body.rowLimit
      return Promise.resolve({ rows: fixtureRows(rowLimit) })
    })

    const client = googleSearchConsole('t', { fetch: mockFetch as any })
    const batches: any[] = []
    for await (const batch of client.query('https://x/', gsc.select(page).where(range).limit(150)))
      batches.push(batch)

    const total = batches.reduce((s, b) => s + b.length, 0)
    expect(total).toBe(150)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][1].body.rowLimit).toBe(150)
  })

  it('uses 25k per-page when no limit set and stops on empty page', async () => {
    let call = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      call++
      // Per Google docs: paginate until rows.length === 0. A short page
      // is NOT a reliable end-of-data marker.
      if (call === 1)
        return Promise.resolve({ rows: fixtureRows(25_000) })
      if (call === 2)
        return Promise.resolve({ rows: fixtureRows(10, 25_000) })
      return Promise.resolve({ rows: [] })
    })

    const client = googleSearchConsole('t', { fetch: mockFetch as any })
    let total = 0
    for await (const batch of client.query('https://x/', gsc.select(page).where(range)))
      total += batch.length

    expect(total).toBe(25_010)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(mockFetch.mock.calls[0][1].body.rowLimit).toBe(25_000)
  })

  it('pages with smaller last request when cap not page-aligned', async () => {
    const mockFetch = vi.fn().mockImplementation((_url, opts) => {
      const rowLimit = opts.body.rowLimit
      return Promise.resolve({ rows: fixtureRows(rowLimit, opts.body.startRow ?? 0) })
    })

    const client = googleSearchConsole('t', { fetch: mockFetch as any })
    let total = 0
    // limit > page size, force multi-page
    for await (const batch of client.query('https://x/', gsc.select(page).where(range).limit(40_000)))
      total += batch.length

    expect(total).toBe(40_000)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][1].body.rowLimit).toBe(25_000)
    expect(mockFetch.mock.calls[1][1].body.rowLimit).toBe(15_000)
  })
})
