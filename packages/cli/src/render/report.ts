import type { ReportResult } from '@gscdump/engine/report'
import type { OutputOptions } from './layout'
import { columnsFor } from './analysis'
import { renderBars, renderMetrics } from './charts'
import { renderTable, textLines } from './layout'

export function renderCliReport(report: ReportResult, options: OutputOptions): string {
  const lines = [
    ...textLines(`gscdump / ${report.id}`, options, 'accent'),
    ...textLines(`Site: ${report.site}`, options),
    ...textLines(`${report.window.start} to ${report.window.end} (${report.window.days} days)`, options, 'muted'),
  ]
  if (report.window.comparison)
    lines.push(...textLines(`Previous: ${report.window.comparison.start} to ${report.window.comparison.end}`, options, 'muted'))
  if (report.meta.degraded)
    lines.push(...textLines(`! Partial Report: ${report.meta.steps.filter(step => step.status === 'error').map(step => step.key).join(', ')}`, options, 'warning'))
  for (const section of report.sections) {
    lines.push('', ...textLines(`${section.title} [${section.severity}]${section.coverage === 'partial' ? ' (partial)' : ''}`, options, section.coverage === 'partial' ? 'warning' : 'accent'))
    if (section.summary.magnitudeLabel)
      lines.push(...textLines(section.summary.magnitudeLabel, options))
    if (!section.findings.length) {
      lines.push(...textLines(section.coverage === 'partial' ? 'Data unavailable for this Section.' : 'No results for this period.', options))
      continue
    }
    const changes = section.findings.filter(finding => finding.delta?.metric === 'clicks')
    if (changes.length)
      lines.push(...renderBars(changes.map(finding => ({ label: finding.entity.value, value: finding.delta!.current - finding.delta!.prior })), 'clicks', options, true))
    for (const finding of section.findings) {
      lines.push('', ...textLines(finding.entity.value, options))
      const delta = finding.delta
      if (delta)
        lines.push(...renderMetrics([{ key: delta.metric, label: delta.metric, current: delta.current, previous: delta.prior }], options))
      const metrics = Object.fromEntries(Object.entries(finding.metrics).filter(([key]) => !delta || ![delta.metric, `${delta.metric}Change`, `${delta.metric}ChangePercent`].includes(key)))
      lines.push(...renderTable([metrics], columnsFor([metrics]), options))
      if (finding.why)
        lines.push(...textLines(finding.why, options, 'muted'))
    }
    if (section.truncated && section.truncated.total > section.truncated.kept)
      lines.push(...textLines(`Showing ${section.truncated.kept} of ${section.truncated.total} results.`, options, 'muted'))
  }
  if (!report.sections.length)
    lines.push('', ...textLines('No Sections in this Report.', options))
  return lines.join('\n')
}
