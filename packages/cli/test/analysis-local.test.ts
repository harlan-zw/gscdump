import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row, WriteCtx } from '@gscdump/engine/contracts'
import type { GoogleSearchConsoleClient } from 'gscdump'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { AnalyzerCapabilityError, runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createNodeHarness, resetNodeDuckDB } from '@gscdump/engine/node'
import { createEngineQuerySource } from '@gscdump/engine/source'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalStoreUnsupportedError } from '../src/error-handler'

const SITE = 'sc-domain:example.com'

afterAll(() => {
  resetNodeDuckDB()
})

async function seedPageKeywords(
  harness: ReturnType<typeof createNodeHarness>,
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
      table: 'page_queries',
      date,
    }
    await harness.engine.writeDay(ctx, dayRows)
  }
}

function dispatch(
  harness: ReturnType<typeof createNodeHarness>,
  params: AnalysisParams,
) {
  const source = createEngineQuerySource({
    engine: harness.engine,
    ctx: { userId: harness.userId, siteId: harness.siteIdFor(SITE) },
  })
  return runAnalyzerFromSource(source, params, defaultAnalyzerRegistry)
}

describe('analysis-local', () => {
  it('explains how to run SQL analysis when the live API cannot support it', () => {
    expect(new LocalStoreUnsupportedError('keyword-breadth', 'live').message)
      .toContain('Run gscdump sync, then retry without --live.')
  })

  it('rejects SQL-only analysis before making any live API request', async () => {
    const query = vi.fn(async function* () {
      yield []
    })
    const source = createGscApiQuerySource({
      client: { query } as unknown as GoogleSearchConsoleClient,
      siteUrl: SITE,
    })
    await expect(runAnalyzerFromSource(source, {
      type: 'keyword-breadth',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
    }, defaultAnalyzerRegistry)).rejects.toThrow(AnalyzerCapabilityError)
    expect(query).not.toHaveBeenCalled()
  })

  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-analysis-local-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('dispatches striking-distance against the store', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/guide', query: 'near miss', date: '2026-04-10', clicks: 2, impressions: 500, sum_position: 2500 },
      { url: '/home', query: 'strong', date: '2026-04-10', clicks: 100, impressions: 500, sum_position: 500 },
    ])
    const out = await dispatch(harness, {
      type: 'striking-distance',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
    })
    expect(out.meta.source).toBe('local')
    expect(out.results).toHaveLength(1)
    expect((out.results[0] as { keyword: string }).keyword).toBe('near miss')
  })

  it('rejects unknown tool types with AnalyzerCapabilityError', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await expect(
      dispatch(harness, { type: 'not-a-real-tool' as never }),
    ).rejects.toThrow(AnalyzerCapabilityError)
  })

  it('dispatches opportunity against the store', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/guide', query: 'opportunity candidate', date: '2026-04-10', clicks: 5, impressions: 10000, sum_position: 100000 },
    ])
    const out = await dispatch(harness, {
      type: 'opportunity',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
    })
    expect(out.meta.source).toBe('local')
    expect(out.results.length).toBeGreaterThan(0)
    expect((out.results[0] as { keyword: string }).keyword).toBe('opportunity candidate')
  })

  it('runs SQL-only analysis on local data without a paid account', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/guide', query: 'local keyword', date: '2026-04-10', clicks: 10, impressions: 200, sum_position: 400 },
    ])
    const out = await dispatch(harness, {
      type: 'keyword-breadth',
      startDate: '2026-04-10',
      endDate: '2026-04-10',
    })
    expect(out.meta.source).toBe('local')
    expect(out.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: '1', pageCount: 1 }),
    ]))
  })

  it('dispatches brand when brandTerms provided', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/', query: 'acme shoes', date: '2026-04-10', clicks: 10, impressions: 200, sum_position: 200 },
      { url: '/', query: 'running shoes', date: '2026-04-10', clicks: 5, impressions: 200, sum_position: 600 },
    ])
    const out = await dispatch(harness, {
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

  it('brand throws when brandTerms missing', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await expect(
      dispatch(harness, { type: 'brand' }),
    ).rejects.toThrow('brandTerms')
  })

  it('dispatches movers for comparison periods', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await seedPageKeywords(harness, [
      { url: '/', query: 'rising term', date: '2026-04-10', clicks: 100, impressions: 1000, sum_position: 3000 },
      { url: '/', query: 'rising term', date: '2026-04-03', clicks: 10, impressions: 100, sum_position: 500 },
    ])
    const out = await dispatch(harness, {
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

  it('movers throws when comparison period missing', async () => {
    const harness = createNodeHarness({ dataDir: tmpDir })
    await expect(
      dispatch(harness, { type: 'movers' }),
    ).rejects.toThrow('prevStartDate')
  })
})
