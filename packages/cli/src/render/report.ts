import type { ReportResult } from '@gscdump/engine/report'
import type { OutputOptions } from './layout'
import { parseGscSiteUrl } from 'gscdump'
import { columnsFor, coverageWarning } from './analysis'
import { barColumn, renderMetrics } from './charts'
import { renderTable, textLines } from './layout'

export function renderCliReport(report: ReportResult, options: OutputOptions): string {
  const lines = [
    ...textLines(`${parseGscSiteUrl(report.site).hostname} / ${report.id}`, options, 'accent'),
    ...textLines(`${report.window.start} to ${report.window.end}`, options, 'muted'),
  ]
  if (report.window.comparison)
    lines.push(...textLines(`vs ${report.window.comparison.start} to ${report.window.comparison.end}`, options, 'muted'))
  if (report.meta.degraded)
    lines.push(...textLines(`! Unavailable: ${report.meta.steps.filter(step => step.status === 'error').map(step => step.key).join(', ')}`, options, 'warning'))
  const truncated = report.meta.steps.filter(step => step.coverage?.kind === 'truncated')
  const largest = truncated.reduce((max, step) => Math.max(max, step.coverage?.kind === 'truncated' ? step.coverage.fetched : 0), 0)
  const warning = coverageWarning(truncated.length ? { kind: 'truncated', fetched: largest } : undefined)
  if (warning)
    lines.push(...textLines(`${warning} Steps: ${truncated.map(step => step.key).join(', ')}.`, options, 'warning'))
  const sections = report.sections.filter(section => section.findings.length || section.coverage === 'partial')
  for (const section of sections) {
    const status = section.coverage === 'partial' ? ' (partial)' : ['info', 'low'].includes(section.severity) ? '' : ` [${section.severity}]`
    lines.push('', ...textLines(`${section.title}${status}`, options, section.coverage === 'partial' ? 'warning' : 'accent'))
    if (!section.findings.length)
      continue
    const changes = section.findings.filter(finding => finding.delta?.metric === 'clicks')
    if (changes.length) {
      const rows = changes.map(finding => ({
        ...finding.metrics,
        entity: finding.why ? `${finding.entity.value} (${finding.why})` : finding.entity.value,
        prevClicks: finding.delta!.prior,
        clicks: finding.delta!.current,
        clicksChange: finding.delta!.current - finding.delta!.prior,
        clicksChangePercent: finding.delta!.prior === 0 ? null : (finding.delta!.current - finding.delta!.prior) / Math.abs(finding.delta!.prior) * 100,
      }))
      const extra = [...new Set(changes.flatMap(finding => Object.keys(finding.metrics)))].filter(key => !['clicks', 'clicksChange', 'clicksChangePercent', 'prevClicks', 'lostClicks', 'declinePercent'].includes(key))
      lines.push(...renderTable(rows, [
        { key: 'entity', label: '' },
        ...columnsFor(rows, ['prevClicks', 'clicks']),
        barColumn(rows, 'clicksChange', options, true),
        ...columnsFor(rows, ['clicksChangePercent']).map(column => ({ ...column, label: '%' })),
        ...columnsFor(rows, extra),
      ], options))
    }
    for (const finding of section.findings.filter(finding => finding.delta?.metric !== 'clicks')) {
      lines.push(...textLines(finding.entity.value, options))
      const delta = finding.delta
      if (delta)
        lines.push(...renderMetrics([{ key: delta.metric, label: delta.metric, current: delta.current, previous: delta.prior }], options))
      const metrics = Object.fromEntries(Object.entries(finding.metrics).filter(([key]) => !delta || ![delta.metric, `${delta.metric}Change`, `${delta.metric}ChangePercent`].includes(key)))
      const fields = columnsFor([metrics]).map(column => `${column.label} ${column.format!(metrics[column.key])}`)
      if (fields.length)
        lines.push(...textLines(fields.join('  '), options))
      if (finding.why)
        lines.push(...textLines(finding.why, options, 'muted'))
    }
    if (section.truncated && section.truncated.total > section.truncated.kept)
      lines.push(...textLines(`${section.truncated.kept} of ${section.truncated.total} rows`, options, 'muted'))
  }
  if (!sections.length)
    lines.push('', ...textLines(report.meta.degraded ? 'Data unavailable.' : 'No findings.', options))
  return lines.join('\n')
}
