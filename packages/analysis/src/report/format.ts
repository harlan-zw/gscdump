/**
 * Human-readable text formatter for `ReportResult`. Deterministic; no LLM.
 * Agents should consume `--json`; this exists for `gscdump report <id>`
 * without `--json`.
 */

import type { ReportResult, ReportSection } from '@gscdump/engine/report'

const SEVERITY_GLYPH: Record<string, string> = {
  info: 'i',
  low: '·',
  medium: '!',
  high: '!!',
}

export interface FormatReportOptions {
  /** Cap findings rendered per section. Defaults to all (already bounded by report). */
  maxFindingsPerSection?: number
}

export function formatReport(report: ReportResult, opts: FormatReportOptions = {}): string {
  const lines: string[] = []
  lines.push(`# ${report.id} — ${report.site}`)
  lines.push(`window: ${report.window.start} → ${report.window.end} (${report.window.days}d)`)
  if (report.window.comparison)
    lines.push(`compare: ${report.window.comparison.start} → ${report.window.comparison.end}`)
  if (report.meta.degraded)
    lines.push(`! degraded: ${report.meta.steps.filter(s => s.status === 'error').map(s => s.key).join(', ')}`)
  lines.push('')

  if (report.sections.length === 0) {
    lines.push('(no sections)')
    return lines.join('\n')
  }

  for (const section of report.sections)
    lines.push(...renderSection(section, opts.maxFindingsPerSection))

  return lines.join('\n')
}

function renderSection(section: ReportSection, cap?: number): string[] {
  const lines: string[] = []
  const glyph = SEVERITY_GLYPH[section.severity] ?? ''
  lines.push(`## ${glyph} ${section.title}${section.coverage === 'partial' ? ' (partial)' : ''}`)
  if (section.summary.magnitudeLabel)
    lines.push(`   ${section.summary.magnitudeLabel}`)

  const findings = cap ? section.findings.slice(0, cap) : section.findings
  for (const f of findings) {
    const metricsStr = Object.entries(f.metrics)
      .map(([k, v]) => `${k}=${formatNumber(v)}`)
      .join(' ')
    lines.push(`   - [${f.entity.kind}] ${f.entity.value} ${metricsStr}${f.why ? ` — ${f.why}` : ''}`)
  }
  if (section.truncated && section.truncated.kept < section.truncated.total)
    lines.push(`   … +${section.truncated.total - section.truncated.kept} more`)

  for (const a of section.actions) {
    const target = a.target ? ` ${a.target.kind}=${a.target.value}` : ''
    lines.push(`   → ${a.kind}${target}: ${a.rationale}`)
    if (a.cliHint)
      lines.push(`     $ ${a.cliHint}`)
  }
  lines.push('')
  return lines
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n))
    return String(n)
  if (Number.isInteger(n))
    return String(n)
  return n.toFixed(2)
}
