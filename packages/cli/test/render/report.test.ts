import type { ReportResult } from '@gscdump/engine/report'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { renderCliReport } from '../../src/render/report'

function fixture(): ReportResult {
  return {
    id: 'movers',
    site: 'sc-domain:example.com',
    inputHash: 'fixture',
    generatedAt: '2026-09-01T00:00:00Z',
    window: { start: '2026-08-01', end: '2026-08-28', days: 28, comparison: { start: '2026-07-04', end: '2026-07-31' } },
    sections: [{ id: 'rising', title: 'Rising queries', severity: 'info', coverage: 'full', summary: {}, findings: [{
      entity: { kind: 'query', value: 'example' },
      metrics: { clicks: 120, ctr: 0.012 },
      delta: { metric: 'clicks', current: 120, prior: 100, pct: 20 },
    }], truncated: { kept: 1, total: 20 } }],
    meta: { durationMs: 1, rowsScanned: 20, degraded: false, steps: [] },
  } as ReportResult
}

describe('cLI Reports', () => {
  it.each(['sc-domain:example.com', 'https://example.com/', 'example.com'])('shows the host for Site %s', (site) => {
    const report = { ...fixture(), site }
    const output = renderCliReport(report, { columns: 80, color: false, unicode: true })
    expect(output).toContain('Site: example.com\n')
  })

  it('shows structured deltas, units, and truncation', () => {
    const output = renderCliReport(fixture(), { columns: 80, color: false, unicode: true })
    expect(output).toContain('+20.0%')
    expect(output).toContain('1.20%')
    expect(output).toContain('Showing 1 of 20 results.')
    expect(output).toContain('2026-07-04 to 2026-07-31')
  })

  it('keeps partial coverage visible even when a Section has no findings', () => {
    const report = fixture()
    report.meta.degraded = true
    report.meta.steps = [{ key: 'decay', type: 'decay', status: 'error', error: 'Unavailable' }]
    report.sections[0].coverage = 'partial'
    report.sections[0].findings = []
    const output = renderCliReport(report, { columns: 40, color: false, unicode: false })
    expect(output).toContain('! Partial Report: decay')
    expect(output).toContain('(partial)')
    expect(output).toContain('Data unavailable for this Section.')
    expect(output.split('\n').every(line => stringWidth(line) <= 40)).toBe(true)
  })
})
