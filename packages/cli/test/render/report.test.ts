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
    expect(output).toContain('example.com / movers\n')
  })

  it('shows structured deltas, units, and truncation', () => {
    const output = renderCliReport(fixture(), { columns: 80, color: false, unicode: true })
    expect(output).toContain('+20.0%')
    expect(output).toContain('1.20%')
    expect(output).toContain('1 of 20 rows')
    expect(output).toContain('2026-07-04 to 2026-07-31')
  })

  it('keeps partial coverage visible even when a Section has no findings', () => {
    const report = fixture()
    report.meta.degraded = true
    report.meta.steps = [{ key: 'decay', type: 'decay', status: 'error', error: 'Unavailable' }]
    report.sections[0].coverage = 'partial'
    report.sections[0].findings = []
    const output = renderCliReport(report, { columns: 40, color: false, unicode: false })
    expect(output).toContain('! Unavailable: decay')
    expect(output).toContain('(partial)')
    expect(output).not.toContain('No findings.')
    expect(output.split('\n').every(line => stringWidth(line) <= 40)).toBe(true)
  })

  it('does not repeat empty Sections as separate success messages', () => {
    const report = fixture()
    report.sections[0].findings = []
    const output = renderCliReport(report, { columns: 80, color: false, unicode: true })
    expect(output).toContain('No findings.')
    expect(output).not.toContain('Rising queries')
    expect(output).not.toContain('[info]')
  })

  it('does not repeat the click change as loss metrics or a narrative total', () => {
    const report = fixture()
    report.sections[0].summary.magnitudeLabel = '600 clicks lost'
    report.sections[0].findings = [
      { entity: { kind: 'query', value: 'search analytics' }, metrics: { clicks: 270 }, delta: { metric: 'clicks', current: 270, prior: 570, pct: -52.6 } },
      { entity: { kind: 'page', value: '/pricing' }, metrics: { clicks: 270, lostClicks: 300, declinePercent: 300 / 570 }, delta: { metric: 'clicks', current: 270, prior: 570, pct: -52.6 } },
    ]
    const output = renderCliReport(report, { columns: 80, color: false, unicode: true })
    expect(output).toContain('-300')
    expect(output).toContain('-52.6%')
    expect(output).not.toMatch(/lostClicks|Decline|600 clicks lost|n\/a/)
  })
})
