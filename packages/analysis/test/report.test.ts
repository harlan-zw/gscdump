import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { Analyzer, AnalyzerRegistry, RowQueriesPlan } from '@gscdump/engine/analyzer'
import type { ResolvedWindow } from '@gscdump/engine/period'
import type { ReportContext } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'
import { describe, expect, it } from 'vitest'
import { dryRunReport, runReport } from '../src/report/runtime'
import { createInMemoryQuerySource } from '../src/source/in-memory'

function stubAnalyzer(id: string, output: { results: unknown[], meta?: Record<string, unknown> } | (() => never)): Analyzer {
  return {
    id,
    requires: [],
    build: (): RowQueriesPlan => ({ kind: 'rows', queries: {} }),
    reduce: () => {
      if (typeof output === 'function')
        output()
      return output as { results: never[], meta?: Record<string, unknown> }
    },
  }
}

function stubRegistry(analyzers: Analyzer[]): AnalyzerRegistry {
  const byId = new Map(analyzers.map(a => [a.id, a]))
  return {
    listAnalyzerIds: () => [...byId.keys()].sort(),
    getAnalyzerVariants: id => byId.has(id) ? { rows: byId.get(id)! } : undefined,
    resolveAnalyzer: id => byId.get(id),
    listAnalyzersFor: () => [...byId.values()],
    listAnalyzerIdsFor: () => [...byId.keys()].sort(),
  }
}

const WINDOW: ResolvedWindow = { start: '2025-01-01', end: '2025-01-28', days: 28 }
const SITE = 'sc-domain:example.com'

const TEST_REPORT = defineReport<{ minSeverity?: string }>({
  id: 'test',
  description: 'fixture report',
  defaultPeriod: 'last-28d',
  defaultComparison: 'none',
  plan: () => [
    { key: 'good', type: 'stub-good', params: {}, required: true },
    { key: 'maybe', type: 'stub-bad', params: {}, required: false },
  ],
  reduce: (results) => {
    const goodResult = results.good as AnalysisResult | undefined
    const findings = (goodResult?.results ?? []).map(r => ({
      entity: { kind: 'page' as const, value: String((r as Record<string, unknown>).page ?? 'unknown') },
      metrics: { clicks: Number((r as Record<string, unknown>).clicks ?? 0) },
    }))
    return {
      sections: [
        {
          id: 'good-section',
          title: 'Good',
          severity: 'info',
          summary: {},
          findings,
          coverage: results.maybe ? 'full' : 'partial',
          actions: [],
        },
      ],
    }
  },
})

function ctx(): ReportContext {
  return {
    site: SITE,
    window: WINDOW,
    params: {},
    registryVersion: 'test-1',
  }
}

const source = createInMemoryQuerySource({ queryRows: () => [] })

describe('runReport', () => {
  it('executes plan steps and reduces results into sections', async () => {
    const analyzers = stubRegistry([
      stubAnalyzer('stub-good', { results: [{ page: '/a', clicks: 10 }, { page: '/b', clicks: 5 }] }),
      stubAnalyzer('stub-bad', { results: [] }),
    ])
    const out = await runReport(TEST_REPORT, { source, analyzers, ctx: ctx() })

    expect(out.id).toBe('test')
    expect(out.site).toBe(SITE)
    expect(out.sections).toHaveLength(1)
    expect(out.sections[0]!.findings).toHaveLength(2)
    expect(out.sections[0]!.findings[0]!.entity.value).toBe('/a')
    expect(out.meta.degraded).toBe(false)
    expect(out.meta.steps.map(s => s.status)).toEqual(['done', 'done'])
  })

  it('marks coverage partial and degraded when an optional step fails', async () => {
    const analyzers = stubRegistry([
      stubAnalyzer('stub-good', { results: [{ page: '/a', clicks: 1 }] }),
      stubAnalyzer('stub-bad', () => { throw new Error('boom') }),
    ])
    const out = await runReport(TEST_REPORT, { source, analyzers, ctx: ctx() })

    expect(out.meta.degraded).toBe(true)
    const failed = out.meta.steps.find(s => s.key === 'maybe')!
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('boom')
    expect(out.sections[0]!.coverage).toBe('partial')
  })

  it('throws when a required step fails', async () => {
    const analyzers = stubRegistry([
      stubAnalyzer('stub-good', () => { throw new Error('required-down') }),
      stubAnalyzer('stub-bad', { results: [] }),
    ])
    await expect(runReport(TEST_REPORT, { source, analyzers, ctx: ctx() }))
      .rejects
      .toThrow(/required step "good"/)
  })

  it('produces a stable inputHash across runs (excluding generatedAt)', async () => {
    const analyzers = stubRegistry([
      stubAnalyzer('stub-good', { results: [] }),
      stubAnalyzer('stub-bad', { results: [] }),
    ])
    const a = await runReport(TEST_REPORT, { source, analyzers, ctx: ctx() })
    const b = await runReport(TEST_REPORT, { source, analyzers, ctx: ctx() })
    expect(a.inputHash).toBe(b.inputHash)
    expect(a.inputHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('dryRunReport', () => {
  it('returns plan steps without executing', async () => {
    const out = await dryRunReport(TEST_REPORT, ctx())
    expect(out.steps).toEqual([
      { key: 'good', type: 'stub-good' },
      { key: 'maybe', type: 'stub-bad' },
    ])
    expect(out.windowResolved.days).toBe(28)
  })
})
