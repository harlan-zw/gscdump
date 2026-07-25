/**
 * A report section whose backing analyzer FAILED must not render as a
 * confident zero.
 *
 * Production repro (gscdump.com `report_runs`, report `growth`,
 * 2026-07-20): the report ran against a live-GSC-API source with no
 * `executeSql`, so all four SQL-only analyzers threw
 * `analyzer "<id>" requires capabilities [executeSql] not provided by source`.
 * The stored payload still read `severity: "info"` with
 * `"0 new keywords across 0 weeks (avg 0.0/wk)"` — "the analyzer failed" and
 * "the analyzer returned zero rows" collapsed into the same empty array.
 */

import type { Analyzer, AnalyzerRegistry, SqlPlan } from '@gscdump/engine/analyzer'
import type { ResolvedWindow } from '@gscdump/engine/period'
import type { DefinedReport, ReportContext } from '@gscdump/engine/report'
import { describe, expect, it } from 'vitest'
import { REPORTS } from '../src/report/registry'
import { runReport } from '../src/report/runtime'
import { createInMemoryQuerySource } from '../src/source/in-memory'

/** SQL-only analyzer: no rows variant, so a source without `executeSql` can't run it. */
function sqlOnlyAnalyzer(id: string): Analyzer {
  return {
    id,
    requires: ['executeSql'],
    build: (): SqlPlan => ({ kind: 'sql', sql: 'select 1', params: [] }),
    reduce: () => ({ results: [] as never[] }),
  }
}

function rowsAnalyzer(id: string, results: unknown[] = []): Analyzer {
  return {
    id,
    requires: [],
    build: () => ({ kind: 'rows' as const, queries: {} }),
    reduce: () => ({ results: results as never[] }),
  }
}

/**
 * Mirrors the real registry's capability-aware resolution: SQL-only analyzers
 * resolve to `undefined` when the source can't execute SQL, which is what
 * `runAnalyzerFromSource` turns into an `AnalyzerCapabilityError`.
 */
function capabilityAwareRegistry(sqlOnly: string[], rows: Analyzer[] = []): AnalyzerRegistry {
  const sqlById = new Map(sqlOnly.map(id => [id, sqlOnlyAnalyzer(id)]))
  const rowsById = new Map(rows.map(a => [a.id, a]))
  const ids = [...new Set([...sqlById.keys(), ...rowsById.keys()])].sort()
  return {
    listAnalyzerIds: () => ids,
    getAnalyzerVariants: id => rowsById.has(id) ? { rows: rowsById.get(id)! } : undefined,
    resolveAnalyzer: (id, canExecuteSql) => rowsById.get(id)
      ?? (canExecuteSql ? sqlById.get(id) : undefined),
    listAnalyzersFor: () => [...rowsById.values()],
    listAnalyzerIdsFor: () => ids,
  }
}

/** No `executeSql` — the live-GSC-API fallback source shape. */
const rowsOnlySource = createInMemoryQuerySource({ queryRows: () => [] })

const WINDOW: ResolvedWindow = { start: '2024-08-07', end: '2024-11-04', days: 90 }
const SITE = 'sc-domain:example.com'

describe('growth report against a source with no executeSql (prod repro)', () => {
  const analyzers = capabilityAwareRegistry([
    'content-velocity',
    'keyword-breadth',
    'intent-atlas',
    'long-tail',
  ])
  const ctx: ReportContext = { site: SITE, window: WINDOW, params: {}, registryVersion: 't' }

  it('reports every step as errored', async () => {
    const { growthReport } = await import('../src/report/reports/growth')
    const out = await runReport(growthReport, { source: rowsOnlySource, analyzers, ctx })
    expect(out.meta.degraded).toBe(true)
    expect(out.meta.steps.map(s => s.status)).toEqual(['error', 'error', 'error', 'error'])
    expect(out.meta.steps[0]!.error).toContain('not provided by source')
  })

  it('does not present the failed sections as confident zeros', async () => {
    const { growthReport } = await import('../src/report/reports/growth')
    const out = await runReport(growthReport, { source: rowsOnlySource, analyzers, ctx })

    expect(out.sections.map(s => s.id)).toEqual([
      'content-velocity',
      'keyword-breadth',
      'intent-atlas',
      'long-tail',
    ])
    for (const section of out.sections) {
      expect(section.severity, `${section.id} severity`).toBe('unknown')
      expect(section.summary.magnitudeLabel, `${section.id} magnitudeLabel`)
        .toMatch(/unavailable/i)
      expect(section.findings, `${section.id} findings`).toEqual([])
      expect(section.actions, `${section.id} actions`).toEqual([])
      // An artifact points at an analyzer the caller could re-run; the one
      // backing this section provably cannot run against this source.
      expect(section.artifact, `${section.id} artifact`).toBeUndefined()
    }
    // The exact fabricated strings from the production payload.
    const labels = out.sections.map(s => s.summary.magnitudeLabel)
    expect(labels).not.toContain('0 new keywords across 0 weeks (avg 0.0/wk)')
    expect(labels).not.toContain('no data')
    expect(labels).not.toContain('0 clusters covering 0 keywords')
    expect(labels).not.toContain('0 pages analysed; 0 head-heavy')
  })
})

describe('priority report with every signal failing', () => {
  it('marks the composed section unknown rather than "0 actions ranked"', async () => {
    const analyzers = capabilityAwareRegistry([
      'striking-distance',
      'opportunity',
      'cannibalization',
      'ctr-anomaly',
      'change-point',
    ])
    const window: ResolvedWindow = {
      start: '2025-01-01',
      end: '2025-01-28',
      days: 28,
      comparison: { start: '2024-12-04', end: '2024-12-31' },
    }
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const { priorityReport } = await import('../src/report/reports/priority')
    const out = await runReport(priorityReport, { source: rowsOnlySource, analyzers, ctx })

    expect(out.meta.degraded).toBe(true)
    expect(out.sections[0]!.severity).toBe('unknown')
    expect(out.sections[0]!.summary.magnitudeLabel).not.toBe('0 actions ranked')
  })
})

describe('partially-covered sections stay real', () => {
  it('keeps a section whose other feeding step succeeded', async () => {
    // movers: `movers` (required) succeeds with a declining row; `decay` and
    // `striking` fail. `decliners` is fed by BOTH movers and decay — it still
    // has real content, so it must NOT be flattened to unknown.
    const analyzers = capabilityAwareRegistry(
      ['decay', 'striking-distance'],
      [rowsAnalyzer('movers', [
        { keyword: 'cheap widgets', page: '/b', recentClicks: 10, baselineClicks: 80, clicksChange: -70, clicksChangePercent: -0.875, positionChange: 6, direction: 'declining' },
      ])],
    )
    const window: ResolvedWindow = {
      start: '2025-01-22',
      end: '2025-01-28',
      days: 7,
      comparison: { start: '2025-01-15', end: '2025-01-21' },
    }
    const ctx: ReportContext = { site: SITE, window, params: {}, registryVersion: 't' }
    const { moversReport } = await import('../src/report/reports/movers')
    const out = await runReport(moversReport, { source: rowsOnlySource, analyzers, ctx })

    const byId = new Map(out.sections.map(s => [s.id, s]))
    expect(byId.get('rising')!.severity).not.toBe('unknown')
    const decliners = byId.get('decliners')!
    expect(decliners.severity).not.toBe('unknown')
    expect(decliners.findings.length).toBeGreaterThan(0)
    expect(decliners.coverage).toBe('partial')
    // `striking` is the section's only feeding step and it failed.
    expect(byId.get('striking-distance')!.severity).toBe('unknown')
  })
})

/**
 * Drift guard for the `feeds` declaration: a section id no plan step claims
 * can never be normalized, so the confident-zero bug would silently return
 * for it. Every section a report emits must be claimed by at least one step.
 */
describe('every report declares which sections each plan step feeds', () => {
  const paramsByReport: Record<string, object> = {
    'triage': { target: '/blog/foo', targetKind: 'page' },
    'pre-publish': { topic: 'widget' },
    'brand': { brandTerms: 'acme' },
  }
  const window: ResolvedWindow = {
    start: '2025-01-01',
    end: '2025-01-28',
    days: 28,
    comparison: { start: '2024-12-04', end: '2024-12-31' },
  }

  for (const report of REPORTS as readonly DefinedReport<never>[]) {
    it(`${report.id}`, async () => {
      const params = (paramsByReport[report.id] ?? {}) as never
      const ctx = { site: SITE, window, params, registryVersion: 't' } as ReportContext<never>
      const steps = report.plan(params, window)
      const analyzers = capabilityAwareRegistry(
        [],
        steps.map(s => rowsAnalyzer(s.type)),
      )
      const out = await runReport(report, { source: rowsOnlySource, analyzers, ctx })
      const declared = new Set(steps.flatMap(s => s.feeds ?? [s.key]))
      const emitted = out.sections.map(s => s.id)
      const unclaimed = emitted.filter(id => !declared.has(id))
      expect(unclaimed, `${report.id}: sections no plan step declares in \`feeds\``).toEqual([])
    })
  }
})
