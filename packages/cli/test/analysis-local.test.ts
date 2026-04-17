import type { Row, WriteCtx } from 'gscdump/analytics/contracts'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resetNodeDuckDB } from 'gscdump/analytics/node'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hasLocalData,
  LocalStoreUnsupportedError,
  runLocalAnalysis,
} from '../src/analysis-local'
import { createAnalyticsHarness } from '../src/analytics'

const SITE = 'sc-domain:example.com'

afterAll(() => {
  resetNodeDuckDB()
})

async function seedPageKeywords(
  harness: ReturnType<typeof createAnalyticsHarness>,
  rows: Array<{ url: string, query: string, date: string, clicks: number, impressions: number, sum_position: number }>,
): Promise<void> {
  const byDate = new Map<string, Row[]>()
  for (const r of rows) {
    const bucket = byDate.get(r.date) ?? []
    bucket.push({ ...r })
    byDate.set(r.date, bucket)
  }
  for (const [date, dayRows] of byDate) {
    const ctx: WriteCtx = {
      userId: harness.userId,
      siteId: harness.siteIdFor(SITE),
      table: 'page_keywords',
      date,
    }
    await harness.engine.writeDay(ctx, dayRows)
  }
}

describe('analysis-local', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-analysis-local-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true }).catch(() => {})
  })

  it('hasLocalData returns false on an empty store', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    expect(await hasLocalData(harness, SITE)).toBe(false)
  })

  it('hasLocalData returns true once a partition is written', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/guide', query: 'best practices', date: '2026-04-10', clicks: 5, impressions: 200, sum_position: 2000 },
    ])
    expect(await hasLocalData(harness, SITE)).toBe(true)
  })

  it('runLocalAnalysis dispatches striking-distance against the store', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    // One striking-distance candidate (position ~6, high impressions, low CTR)
    // and one row outside the window (position ~2).
    await seedPageKeywords(harness, [
      { url: '/guide', query: 'near miss', date: '2026-04-10', clicks: 2, impressions: 500, sum_position: 2500 },
      { url: '/home', query: 'strong', date: '2026-04-10', clicks: 100, impressions: 500, sum_position: 500 },
    ])
    const out = await runLocalAnalysis(harness, SITE, {
      type: 'striking-distance',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
    })
    expect(out.meta.source).toBe('local')
    expect(out.results).toHaveLength(1)
    expect((out.results[0] as { keyword: string }).keyword).toBe('near miss')
  })

  it('runLocalAnalysis rejects unknown tool types with LocalStoreUnsupportedError', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    // All current tools are wired; force the dispatcher's default branch with
    // an unknown type to exercise the safety-net error path.
    await expect(
      runLocalAnalysis(harness, SITE, { type: 'not-a-real-tool' as never }),
    ).rejects.toThrow(LocalStoreUnsupportedError)
  })

  it('runLocalAnalysis dispatches opportunity against the store', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    await seedPageKeywords(harness, [
      // High-impression keyword, position ~11, low CTR: strong opportunity candidate.
      { url: '/guide', query: 'opportunity candidate', date: '2026-04-10', clicks: 5, impressions: 10000, sum_position: 100000 },
    ])
    const out = await runLocalAnalysis(harness, SITE, {
      type: 'opportunity',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
    })
    expect(out.meta.source).toBe('local')
    expect(out.results.length).toBeGreaterThan(0)
    expect((out.results[0] as { keyword: string }).keyword).toBe('opportunity candidate')
  })

  it('runLocalAnalysis dispatches brand when brandTerms provided', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/', query: 'acme shoes', date: '2026-04-10', clicks: 10, impressions: 200, sum_position: 200 },
      { url: '/', query: 'running shoes', date: '2026-04-10', clicks: 5, impressions: 200, sum_position: 600 },
    ])
    const out = await runLocalAnalysis(harness, SITE, {
      type: 'brand',
      brandTerms: ['acme'],
      startDate: '2026-04-10',
      endDate: '2026-04-10',
    })
    expect(out.meta.source).toBe('local')
    expect(out.meta.summary).toBeDefined()
    const brandRow = (out.results as Array<{ segment: string, query: string }>).find(r => r.segment === 'brand')
    expect(brandRow?.query).toBe('acme shoes')
  })

  it('runLocalAnalysis brand throws when brandTerms missing', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    await expect(
      runLocalAnalysis(harness, SITE, { type: 'brand' }),
    ).rejects.toThrow('brandTerms')
  })

  it('runLocalAnalysis dispatches movers for comparison periods', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/', query: 'rising term', date: '2026-04-10', clicks: 100, impressions: 1000, sum_position: 3000 },
      { url: '/', query: 'rising term', date: '2026-04-03', clicks: 10, impressions: 100, sum_position: 500 },
    ])
    const out = await runLocalAnalysis(harness, SITE, {
      type: 'movers',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      prevStartDate: '2026-04-03',
      prevEndDate: '2026-04-03',
    })
    expect(out.meta.source).toBe('local')
    const rising = (out.results as Array<{ direction: string, keyword: string }>).filter(r => r.direction === 'rising')
    expect(rising.length).toBeGreaterThan(0)
    expect(rising[0].keyword).toBe('rising term')
  })

  it('runLocalAnalysis movers throws when comparison period missing', async () => {
    const harness = createAnalyticsHarness({ mode: 'local', dataDir: tmpDir })
    await expect(
      runLocalAnalysis(harness, SITE, { type: 'movers' }),
    ).rejects.toThrow('prevStartDate')
  })
})
