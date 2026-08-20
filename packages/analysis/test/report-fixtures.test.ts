import type { Analyzer, AnalyzerRegistry, RowQueriesPlan } from '@gscdump/engine/analyzer'
import type { ResolvedWindow } from '@gscdump/engine/period'
import type { ReportContext } from '@gscdump/engine/report'
import { describe, expect, it } from 'vitest'
import { healthReport } from '../src/report/reports/health'
import { moversReport } from '../src/report/reports/movers'
import { runReport } from '../src/report/runtime'
import { createInMemoryQuerySource } from '../src/source/in-memory'

function stubAnalyzer(id: string, results: unknown[]): Analyzer {
  return {
    id,
    requires: [],
    build: (): RowQueriesPlan => ({ kind: 'rows', queries: {} }),
    reduce: () => ({ results: results as never[] }),
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

const SITE = 'sc-domain:example.com'
const source = createInMemoryQuerySource({ queryRows: () => [] })

describe('movers report', () => {
  const window: ResolvedWindow = {
    start: '2025-01-22',
    end: '2025-01-28',
    days: 7,
    comparison: { start: '2025-01-15', end: '2025-01-21' },
  }

  it('produces rising / decliners / striking-distance sections', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('movers', [
        { keyword: 'best widgets', page: '/a', recentClicks: 120, baselineClicks: 50, recentImpressions: 1000, baselineImpressions: 800, recentPosition: 5, baselinePosition: 7, clicksChange: 70, clicksChangePercent: 1.4, impressionsChangePercent: 0.25, positionChange: -2, direction: 'rising' },
        { keyword: 'cheap widgets', page: '/b', recentClicks: 10, baselineClicks: 80, recentImpressions: 200, baselineImpressions: 600, recentPosition: 12, baselinePosition: 6, clicksChange: -70, clicksChangePercent: -0.875, impressionsChangePercent: -0.66, positionChange: 6, direction: 'declining' },
      ]),
      stubAnalyzer('decay', [
        { page: '/c', currentClicks: 5, previousClicks: 100, lostClicks: 95, declinePercent: 0.95, currentPosition: 9, previousPosition: 4, positionDrop: 5 },
      ]),
      stubAnalyzer('striking-distance', [
        { keyword: 'widget guide', page: '/guide', clicks: 8, impressions: 4000, ctr: 0.002, position: 11, potentialClicks: 600 },
      ]),
    ])
    const out = await runReport(moversReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['rising', 'decliners', 'striking-distance'])
    expect(out.sections[0]!.findings[0]!.entity.value).toBe('best widgets')
    expect(out.sections[1]!.severity).toBe('high') // 70 + 95 = 165 lost
    expect(out.sections[2]!.findings[0]!.metrics.potentialClicks).toBe(600)
    expect(out.meta.degraded).toBe(false)
  })

  it('throws when called without a comparison window', async () => {
    const noCmpWindow: ResolvedWindow = { start: '2025-01-22', end: '2025-01-28', days: 7 }
    const ctx: ReportContext = { site: SITE, window: noCmpWindow, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('movers', []),
      stubAnalyzer('decay', []),
      stubAnalyzer('striking-distance', []),
    ])
    await expect(runReport(moversReport, { source, analyzers, ctx }))
      .rejects
      .toThrow(/comparison window/)
  })
})

describe('health report', () => {
  const window: ResolvedWindow = { start: '2025-01-01', end: '2025-01-28', days: 28 }

  it('produces ctr-anomaly / change-point / position-volatility sections', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('ctr-anomaly', [
        { keyword: 'foo', page: '/a', breachDaysDown: 4, breachDaysUp: 0, clicksLost: 50, severity: 0.8, maxZ: 3.1, baselineCtr: 0.12, baselinePosition: 4, totalImpressions: 800, totalClicks: 30, series: [] },
      ]),
      stubAnalyzer('change-point', [
        { keyword: 'bar', page: '/b', totalDays: 28, totalImpressions: 9000, changeDate: '2025-01-15', llr: 12.3, leftMean: 0.05, rightMean: 0.02, delta: -0.03, leftStddev: 0.01, rightStddev: 0.01, direction: 'worsened', series: [] },
      ]),
      stubAnalyzer('position-volatility', [
        { page: '/x', avgVolatility: 1.4, peakVolatility: 4.2, totalImpressions: 5000, days: [] },
      ]),
    ])
    const out = await runReport(healthReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['ctr-anomaly', 'change-point', 'position-volatility'])
    expect(out.sections[0]!.findings[0]!.metrics.clicksLost).toBe(50)
    expect(out.sections[1]!.findings[0]!.entity.value).toBe('bar')
    expect(out.sections[2]!.findings[0]!.metrics.peakVolatility).toBe(4.2)
  })

  it('marks coverage partial when an optional step fails', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('ctr-anomaly', []),
      // change-point + position-volatility absent → AnalyzerCapabilityError → step status 'error'
    ])
    const out = await runReport(healthReport, { source, analyzers, ctx })
    expect(out.meta.degraded).toBe(true)
    expect(out.sections[1]!.coverage).toBe('partial')
    expect(out.sections[2]!.coverage).toBe('partial')
  })
})

describe('opportunities report', () => {
  const window: ResolvedWindow = { start: '2025-01-01', end: '2025-01-28', days: 28 }

  it('produces 4 sections with correct severities', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('striking-distance', [
        { keyword: 'k1', page: '/p1', clicks: 1, impressions: 200, ctr: 0.005, position: 9, potentialClicks: 30 },
      ]),
      stubAnalyzer('opportunity', [
        { keyword: 'k2', page: '/p2', clicks: 5, impressions: 1000, ctr: 0.005, position: 6, opportunityScore: 0.8, potentialClicks: 50, factors: {} },
      ]),
      stubAnalyzer('zero-click', [
        { query: 'k3', page: '/p3', clicks: 0, impressions: 800, ctr: 0, position: 12 },
      ]),
      stubAnalyzer('query-migration', [
        { sourcePage: '/old', targetPage: '/new', weight: 0.9, queryCount: 12, exactCount: 8, fuzzyCount: 4, examples: [] },
      ]),
    ])
    const { opportunitiesReport } = await import('../src/report/reports/opportunities')
    const out = await runReport(opportunitiesReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['striking-distance', 'low-ctr', 'zero-click', 'query-migration'])
    expect(out.meta.degraded).toBe(false)
  })
})

describe('risks report', () => {
  const window: ResolvedWindow = {
    start: '2025-01-01',
    end: '2025-01-28',
    days: 28,
    comparison: { start: '2024-12-04', end: '2024-12-31' },
  }

  it('produces 4 sections; severity scales with lost clicks', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('decay', [
        { page: '/dying', currentClicks: 5, previousClicks: 300, lostClicks: 295, declinePercent: 0.98, currentPosition: 11, previousPosition: 5, positionDrop: 6 },
      ]),
      stubAnalyzer('cannibalization', [
        { keyword: 'cannibal', totalClicks: 50, totalImpressions: 2000, competitorCount: 2, competitors: [{ url: '/a' }, { url: '/b' }] },
      ]),
      stubAnalyzer('dark-traffic', [
        { url: '/dark', totalClicks: 100, attributedClicks: 30, darkClicks: 70, darkPercent: 0.7, keywordCount: 12 },
      ]),
      stubAnalyzer('device-gap', [
        { date: '2025-01-15', desktop: { ctr: 0.04, position: 5 }, mobile: { ctr: 0.02, position: 9 }, gaps: { ctrGap: 0.02, positionGap: -4 } },
      ]),
    ])
    const { risksReport } = await import('../src/report/reports/risks')
    const out = await runReport(risksReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['decay', 'cannibalization', 'dark-traffic', 'device-gap'])
    expect(out.sections[0]!.severity).toBe('high')
    expect(out.sections[1]!.findings[0]!.metrics.pages).toBe(2)
  })

  it('throws without a comparison window', async () => {
    const noCmp: ResolvedWindow = { start: '2025-01-01', end: '2025-01-28', days: 28 }
    const ctx: ReportContext = { site: SITE, window: noCmp, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('decay', []),
      stubAnalyzer('cannibalization', []),
      stubAnalyzer('dark-traffic', []),
      stubAnalyzer('device-gap', []),
    ])
    const { risksReport } = await import('../src/report/reports/risks')
    await expect(runReport(risksReport, { source, analyzers, ctx })).rejects.toThrow(/comparison window/)
  })
})

describe('triage report', () => {
  const window: ResolvedWindow = { start: '2025-01-01', end: '2025-03-31', days: 90 }

  it('filters change-points + volatility to the target page', async () => {
    const ctx: ReportContext = {
      site: SITE,
      window,
      params: { target: '/blog/foo', targetKind: 'page' },
      registryVersion: 't',
    }
    const analyzers = stubRegistry([
      stubAnalyzer('change-point', [
        { keyword: 'k1', page: '/blog/foo', changeDate: '2025-02-15', delta: -0.05, llr: 8.2, leftMean: 0.05, rightMean: 0.0, leftStddev: 0.01, rightStddev: 0.01, totalDays: 90, totalImpressions: 1000, direction: 'worsened', series: [] },
        { keyword: 'k2', page: '/other', changeDate: '2025-02-20', delta: -0.1, llr: 12.0, leftMean: 0.05, rightMean: 0.0, leftStddev: 0.01, rightStddev: 0.01, totalDays: 90, totalImpressions: 1000, direction: 'worsened', series: [] },
      ]),
      stubAnalyzer('query-migration', [
        { sourcePage: '/blog/foo', targetPage: '/blog/bar', weight: 0.7, queryCount: 5, exactCount: 3, fuzzyCount: 2, examples: [] },
      ]),
      stubAnalyzer('position-volatility', [
        { page: '/blog/foo', avgVolatility: 1.2, peakVolatility: 3.5, totalImpressions: 4000, days: [] },
        { page: '/other', avgVolatility: 2.0, peakVolatility: 5.0, totalImpressions: 8000, days: [] },
      ]),
    ])
    const { triageReport } = await import('../src/report/reports/triage')
    const out = await runReport(triageReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['change-point', 'query-migration', 'position-volatility'])
    expect(out.sections[0]!.findings).toHaveLength(1)
    expect(out.sections[0]!.findings[0]!.entity.value).toBe('/blog/foo')
    expect(out.sections[1]!.findings).toHaveLength(1)
    expect(out.sections[2]!.findings).toHaveLength(1)
    expect(out.sections[2]!.findings[0]!.entity.value).toBe('/blog/foo')
  })

  it('throws without a target', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('change-point', []),
      stubAnalyzer('query-migration', []),
      stubAnalyzer('position-volatility', []),
    ])
    const { triageReport } = await import('../src/report/reports/triage')
    await expect(runReport(triageReport, { source, analyzers, ctx })).rejects.toThrow(/--target/)
  })
})

describe('pre-publish report', () => {
  const window: ResolvedWindow = { start: '2025-01-01', end: '2025-03-31', days: 90 }

  it('surfaces cannibalization + striking-distance entries that touch the topic', async () => {
    const ctx: ReportContext = {
      site: SITE,
      window,
      params: { topic: 'widget' },
      registryVersion: 't',
    }
    const analyzers = stubRegistry([
      stubAnalyzer('cannibalization', [
        { keyword: 'best widget guide', totalClicks: 30, totalImpressions: 1500, competitorCount: 2, competitors: [{ url: '/a' }, { url: '/b' }] },
        { keyword: 'unrelated', totalClicks: 90, totalImpressions: 6000, competitorCount: 1, competitors: [{ url: '/c' }] },
      ]),
      stubAnalyzer('striking-distance', [
        { keyword: 'cheap widgets', page: '/p1', clicks: 2, impressions: 1200, ctr: 0.001, position: 9, potentialClicks: 80 },
        { keyword: 'apples', page: '/p2', clicks: 1, impressions: 200, ctr: 0.005, position: 12, potentialClicks: 20 },
      ]),
    ])
    const { prePublishReport } = await import('../src/report/reports/pre-publish')
    const out = await runReport(prePublishReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['cannibalization-risk', 'striking-peers'])
    expect(out.sections[0]!.findings).toHaveLength(1)
    expect(out.sections[0]!.findings[0]!.entity.value).toBe('best widget guide')
    expect(out.sections[1]!.findings).toHaveLength(1)
    expect(out.sections[1]!.findings[0]!.entity.value).toBe('cheap widgets')
  })

  it('throws without a topic', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('cannibalization', []),
      stubAnalyzer('striking-distance', []),
    ])
    const { prePublishReport } = await import('../src/report/reports/pre-publish')
    await expect(runReport(prePublishReport, { source, analyzers, ctx })).rejects.toThrow(/--topic/)
  })
})

describe('growth report', () => {
  const window: ResolvedWindow = { start: '2024-08-07', end: '2024-11-04', days: 90 }

  it('aggregates across 4 strategic signals; long-tail has findings', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('content-velocity', [
        { week: '2024-W36', newKeywords: 30, totalKeywords: 200 },
        { week: '2024-W37', newKeywords: 25, totalKeywords: 215 },
      ]),
      stubAnalyzer('keyword-breadth', [
        { bucket: '1-5', pageCount: 80 },
        { bucket: '6-20', pageCount: 30 },
      ]),
      stubAnalyzer('intent-atlas', [
        { clusterKey: 'guides', keywordCount: 40, totalImpressions: 5000, totalClicks: 200, ctr: 0.04, avgPosition: 7 },
        { clusterKey: 'reviews', keywordCount: 25, totalImpressions: 3000, totalClicks: 150, ctr: 0.05, avgPosition: 5 },
      ]),
      stubAnalyzer('long-tail', [
        { page: '/a', queryCount: 500, totalImpressions: 9000, totalClicks: 200, slope: -0.5, intercept: 1, r2: 0.9, headImpressions: 7200, headShare: 0.8, fingerprint: 'head-heavy', points: [] },
        { page: '/b', queryCount: 200, totalImpressions: 4000, totalClicks: 100, slope: -0.3, intercept: 1, r2: 0.8, headImpressions: 1500, headShare: 0.4, fingerprint: 'balanced', points: [] },
      ]),
    ])
    const { growthReport } = await import('../src/report/reports/growth')
    const out = await runReport(growthReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['content-velocity', 'keyword-breadth', 'intent-atlas', 'long-tail'])
    expect(out.sections[0]!.summary.magnitudeLabel).toContain('55 new keywords')
    expect(out.sections[3]!.findings).toHaveLength(2)
    expect(out.sections[3]!.findings[0]!.entity.value).toBe('/a')
  })
})

describe('brand report', () => {
  const window: ResolvedWindow = { start: '2025-01-01', end: '2025-01-28', days: 28 }

  it('surfaces top brand keywords + concentration', async () => {
    const ctx: ReportContext = {
      site: SITE,
      window,
      params: { brandTerms: 'acme,acme corp' },
      registryVersion: 't',
    }
    const brandResult = {
      results: [
        { query: 'acme product', clicks: 100, impressions: 800, ctr: 0.125, position: 2, segment: 'brand' },
        { query: 'best widgets', clicks: 50, impressions: 1500, ctr: 0.033, position: 6, segment: 'non-brand' },
      ],
      meta: {
        summary: { brandClicks: 100, nonBrandClicks: 50, brandShare: 0.667, brandImpressions: 800, nonBrandImpressions: 1500 },
      },
    }
    const analyzers: Parameters<typeof runReport>[1]['analyzers'] = {
      listAnalyzerIds: () => ['brand', 'concentration'],
      getAnalyzerVariants: () => undefined,
      resolveAnalyzer: (id: string) => ({
        id,
        requires: [],
        build: () => ({ kind: 'rows' as const, queries: {} }),
        reduce: () => id === 'brand'
          ? brandResult
          : { results: [{ giniCoefficient: 0.6, hhi: 1800, topNConcentration: 0.45, topNItems: [{ identifier: 'acme product', clicks: 100, share: 0.45 }], totalItems: 100, totalClicks: 220, riskLevel: 'medium' }] },
      }),
      listAnalyzersFor: () => [],
      listAnalyzerIdsFor: () => ['brand', 'concentration'],
    }
    const { brandReport } = await import('../src/report/reports/brand')
    const out = await runReport(brandReport, { source, analyzers, ctx })
    expect(out.sections.map(s => s.id)).toEqual(['brand-split', 'concentration'])
    expect(out.sections[0]!.findings[0]!.entity.value).toBe('acme product')
    expect(out.sections[0]!.summary.magnitudeLabel).toContain('brand share 66.7%')
    expect(out.sections[1]!.severity).toBe('medium')
  })

  it('throws without --brand-terms', async () => {
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const analyzers = stubRegistry([
      stubAnalyzer('brand', []),
      stubAnalyzer('concentration', []),
    ])
    const { brandReport } = await import('../src/report/reports/brand')
    await expect(runReport(brandReport, { source, analyzers, ctx })).rejects.toThrow(/--brand-terms/)
  })
})
