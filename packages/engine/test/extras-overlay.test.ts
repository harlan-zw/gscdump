// The generic extras-overlay seam (ADR-0017): runOptimizedQuery prefers an
// optional overlay per extra and falls back to the live SQL when it declines.
// Pure-seam coverage with a fake runSQL — no DuckDB needed.

import type { BuilderState } from 'gscdump/query'
import type { RunSQLFn } from '../src/resolver/run-query'
import { describe, expect, it, vi } from 'vitest'
import { createRollupExtrasOverlay } from '../src/resolver/extras-overlay'
import { runOptimizedQuery } from '../src/resolver/run-query'

// Distinguish the main aggregate query (selects totalCount) from the canonical
// extra (selects joinKey) without coupling to the full SQL text.
function fakeRunSQL(extraRows: Array<Record<string, unknown>>): RunSQLFn {
  return async ({ sql }) => {
    if (sql.includes('joinKey'))
      return { rows: extraRows }
    return { rows: [{ totalCount: 1, totalClicks: 7, totalImpressions: 70, totalCtr: 0.1, totalPosition: 3 }] }
  }
}

const ctx = { userId: 'u1', siteId: 's1', table: 'queries' as const }
const dateRange = { startDate: '2026-03-01', endDate: '2026-03-31' }
const canonicalState: BuilderState = {
  dimensions: ['queryCanonical'],
  filter: {
    _filters: [{ dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' }],
  } as any,
}

describe('runOptimizedQuery extras overlay', () => {
  const rawCanonicalFallback = {
    queryDim: { keys: ['u_u1/s1/entities/query_dim/index.parquet'], normalizerVersion: 2, intentVersion: 1 },
    primarySourceFallback: 'raw' as const,
  }

  it('serves the extra from the overlay and skips the live SQL on a hit', async () => {
    const overlayRows = [{ joinKey: 'foo', variantCount: 2, canonicalName: 'Foo', variants: 'Foo:::5:::50:::2.0' }]
    const runSQL = vi.fn(fakeRunSQL([{ joinKey: 'SHOULD_NOT_BE_USED' }]))
    const resolveExtra = vi.fn(async () => overlayRows)

    const result = await runOptimizedQuery(runSQL, ctx, canonicalState, dateRange, { resolveExtra, ...rawCanonicalFallback })

    expect(resolveExtra).toHaveBeenCalledOnce()
    expect(resolveExtra.mock.calls[0]![0]).toMatchObject({ key: 'canonicalExtras' })
    // Only the main query hits runSQL; the extra's live SQL is skipped.
    expect(runSQL).toHaveBeenCalledOnce()
    expect(result.extras).toEqual([{ key: 'canonicalExtras', rows: overlayRows }])
  })

  it('falls back to the live SQL when the overlay declines (null)', async () => {
    const liveRows = [{ joinKey: 'bar', variantCount: 1, canonicalName: 'bar', variants: 'bar:::1:::10:::4.0' }]
    const runSQL = vi.fn(fakeRunSQL(liveRows))
    const resolveExtra = vi.fn(async () => null)

    const result = await runOptimizedQuery(runSQL, ctx, canonicalState, dateRange, { resolveExtra, ...rawCanonicalFallback })

    expect(resolveExtra).toHaveBeenCalledOnce()
    // Both the main query and the extra's live SQL run.
    expect(runSQL).toHaveBeenCalledTimes(2)
    expect(result.extras).toEqual([{ key: 'canonicalExtras', rows: liveRows }])
  })

  it('runs the live SQL when no overlay is supplied and raw fallback is explicit', async () => {
    const liveRows = [{ joinKey: 'bar', variantCount: 1, canonicalName: 'bar', variants: '' }]
    const runSQL = vi.fn(fakeRunSQL(liveRows))

    const result = await runOptimizedQuery(runSQL, ctx, canonicalState, dateRange, rawCanonicalFallback)

    expect(runSQL).toHaveBeenCalledTimes(2)
    expect(result.extras).toEqual([{ key: 'canonicalExtras', rows: liveRows }])
  })
})

describe('createRollupExtrasOverlay', () => {
  it('maps canonicalExtras to the query_canonical_variants rollup', async () => {
    const rows = [{ joinKey: 'foo', variantCount: 2, canonicalName: 'Foo', variants: '' }]
    const reader = vi.fn(async () => rows)
    const overlay = createRollupExtrasOverlay(reader)

    const out = await overlay({ key: 'canonicalExtras', state: canonicalState, ctx: { ...ctx, searchType: 'discover' }, dateRange })

    expect(out).toBe(rows)
    expect(reader).toHaveBeenCalledWith({
      id: 'query_canonical_variants',
      ctx: { userId: 'u1', siteId: 's1' },
      dateRange,
      searchType: 'discover',
    })
  })

  it('declines (null) for keys with no mapped rollup, without calling the reader', async () => {
    const reader = vi.fn(async () => [])
    const overlay = createRollupExtrasOverlay(reader)

    const out = await overlay({ key: 'someOtherExtra', state: canonicalState, ctx, dateRange })

    expect(out).toBeNull()
    expect(reader).not.toHaveBeenCalled()
  })
})
