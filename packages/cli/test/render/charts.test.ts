import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { columnsFor, renderAnalysis } from '../../src/render/analysis'
import { barColumn, renderBars, renderMetrics, renderShare, renderSparklines } from '../../src/render/charts'
import { fitLabel, renderTable, textLines } from '../../src/render/layout'
import { formatChange, formatMetric } from '../../src/render/metrics'
import { resolveOutputOptions } from '../../src/render/terminal'

const plain = { columns: 80, color: false, unicode: true }

describe('cLI chart kit', () => {
  it.each([
    ['ctr', 0.012, '1.20%'],
    ['brandShare', 0.4, '40.0%'],
    ['growthRatio', 1.2, '+20.0%'],
    ['clicksChangePercent', -20, '-20.0%'],
    ['position', 8.36, '8.4'],
    ['bytes', 1048576, '1.00 MiB'],
    ['clicks', 12480, '12,480'],
    ['unknown', 0.01234567, '0.01234567'],
    ['ctr', null, 'n/a'],
    ['ctr', Number.NaN, 'n/a'],
    ['ctr', 1e308, 'n/a'],
    ['ctr', -0.2, 'n/a'],
  ])('formats %s=%s without changing its meaning', (metric, value, expected) => {
    expect(formatMetric(metric, value)).toBe(expected)
  })

  it('expresses CTR differences in percentage points', () => {
    expect(formatChange('ctr', 0.0312, 0.026)).toEqual({ text: '+0.52 pp', direction: 'good' })
    expect(formatChange('position', 8.4, 9.7)).toEqual({ text: 'improved 1.3', direction: 'good' })
    expect(formatChange('clicks', 120, null).text).toBe('No baseline.')
    expect(formatChange('clicks', 120, 0).text).toBe('+120 (previous: 0)')
  })

  it('keeps gains and losses on a symmetric scale', () => {
    const output = renderBars([{ label: 'gain', value: 100 }, { label: 'loss', value: -50 }], 'clicks', plain, true).join('\n')
    expect(output).toContain('│██████████████')
    expect(output).toContain('███████│')
    expect(output).toContain('+100')
    expect(output).toContain('-50')
  })

  it('shows a denominator and keeps zero distinct from missing share values', () => {
    const output = renderShare([{ label: 'Brand', value: 40 }, { label: 'Non-brand', value: 60 }], 'clicks', plain).join('\n')
    expect(output).toContain('40.0%')
    expect(output).toContain('60.0%')
    expect(output).toContain('100 clicks in returned rows')
    expect(renderShare([{ label: 'Brand', value: 0 }], 'clicks', plain).join()).toBe('  No clicks in returned rows.')
    expect(renderShare([{ label: 'Brand', value: null }], 'clicks', plain).join()).toContain('Share unavailable')
  })

  it('keeps zero, constant values, and missing dates visually distinct', () => {
    const range = { start: '2026-08-03', end: '2026-08-23', unit: 'week' as const }
    const output = renderSparklines([
      { label: 'zero', total: 0, points: [{ date: '2026-08-03', value: 0 }, { date: '2026-08-17', value: 0 }] },
      { label: 'steady', total: 200, points: [{ date: '2026-08-03', value: 100 }, { date: '2026-08-17', value: 100 }] },
    ], range, 'clicks', plain).join('\n')
    expect(output).toContain('▁·▁')
    expect(output).toContain('▄·▄')
    expect(output).toContain('· missing')
  })

  it('aggregates consecutive dates when a series exceeds the width', () => {
    const output = renderSparklines([{ label: 'docs', total: 31, points: Array.from({ length: 31 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, value: 1 })) }], { start: '2026-08-01', end: '2026-08-31', unit: 'day' }, 'clicks', { ...plain, columns: 20 }).join('\n')
    expect(output.replace(/\s+/g, ' ')).toContain('sum / 2 days')
  })

  it('retains fields appearing after the first row and formats numeric columns consistently', () => {
    const rows = [{ query: 'one', clicks: 1 }, { query: 'two', clicks: 12000, ctr: 0.012 }]
    const output = renderTable(rows, columnsFor(rows), plain).join('\n')
    expect(output).toContain('12,000')
    expect(output).toContain('1.20%')
    expect(output).toContain('n/a')
  })

  it('uses the query label for Analyzer keyword fields', () => {
    const rows = [{ keyword: 'search analytics', clicks: 120 }]
    const output = renderTable(rows, columnsFor(rows), plain).join('\n')
    expect(output).toContain('query')
    expect(output).toContain('search analytics')
    expect(output).not.toContain('keyword')
  })

  it.each([20, 40, 80, 120])('fits every chart within %s terminal cells', (columns) => {
    const options = { ...plain, columns, color: true }
    const rows = [{ label: '文档 👨‍👩‍👧‍👦 / a very long page label', value: 12480 }, { label: 'second', value: 3120 }]
    const rendered = [
      ...renderBars(rows, 'clicks', options),
      ...renderBars(rows, 'clicks', options, true),
      ...renderShare(rows, 'clicks', options),
      ...renderMetrics([{ key: 'ctr', label: 'CTR', current: 0.012, previous: 0.01 }], options),
      ...renderTable([{ page: rows[0].label, clicks: 12480 }], columnsFor([{ page: rows[0].label, clicks: 12480 }]), options),
    ]
    expect(rendered.every(line => stringWidth(line) <= columns)).toBe(true)
    expect(stripVTControlCharacters(rendered.join('\n'))).toContain('12,480')
  })

  it('does not split emoji or retain terminal commands in labels', () => {
    expect(fitLabel('👨‍👩‍👧‍👦abcdef', 5, plain)).toBe('👨‍👩‍👧‍👦ab…')
    expect(textLines('\x1B[2Jdocs\n\x1B]0;title\x07page', plain).join('\n')).toBe('  docs page')
  })

  it.each([
    [{ isTTY: true, environment: {} }, true, true],
    [{ isTTY: false, environment: {} }, false, true],
    [{ isTTY: true, environment: { NO_COLOR: '1' } }, false, true],
    [{ isTTY: true, environment: { FORCE_COLOR: '0' } }, false, true],
    [{ isTTY: false, environment: { FORCE_COLOR: '1' } }, true, true],
    [{ isTTY: true, environment: { TERM: 'dumb', FORCE_COLOR: '1' } }, false, false],
    [{ isTTY: true, environment: { FORCE_COLOR: '1' }, noColor: true }, false, true],
  ])('respects terminal capabilities: %j', (input, color, unicode) => {
    const options = resolveOutputOptions(input)
    const output = renderBars([{ label: 'docs', value: 1 }], 'clicks', options).join('\n')
    expect(output.includes('\x1B[')).toBe(color)
    expect(output.includes('█')).toBe(unicode)
  })
  it('does not allow a column label to inject terminal controls', () => {
    const rows = [{ value: 12 }]
    const output = renderTable(rows, [{ key: 'value', label: '\x1B[2JCount' }], plain).join('\n')
    expect(output).not.toContain('\x1B')
    expect(output).toContain('Count')
  })
  it('keeps wide tables compact by shortening only text labels', () => {
    const rows = [{ page: `/${'long-path/'.repeat(20)}`, clicks: 12480, ctr: 0.012 }]
    const output = renderTable(rows, columnsFor(rows), plain).join('\n')
    expect(output.split('\n')).toHaveLength(3)
    expect(output).toContain('12,480')
    expect(output).toContain('1.20%')
    expect(output).toContain('…')
  })

  it('puts signed chart values in the same row as the comparison', () => {
    const rows = [{ query: 'search analytics', page: '/pricing', recentClicks: 270, baselineClicks: 570, clicksChange: -300, ctr: 0.018, position: 11 }]
    const output = renderAnalysis({ results: rows, meta: {} }, {
      id: 'movers',
      site: 'sc-domain:example.com',
      start: '2026-08-01',
      end: '2026-08-28',
      previous: { start: '2026-07-01', end: '2026-07-28' },
    }, plain)
    expect(output.match(/search analytics/g)).toHaveLength(1)
    expect(output).toContain('search analytics (/pricing)')
    expect(output).toContain('270')
    expect(output).toContain('570')
    expect(output).toContain('-300')
    expect(output).toContain('│')
    expect(output).not.toMatch(/Shared scale|Weekly data|returned rows|gscdump|Site:/)
  })

  it('keeps chart columns aligned after applying color', () => {
    const options = { ...plain, color: true }
    const rows = [{ query: 'docs', clicks: 12480 }, { query: 'blog', clicks: 0 }]
    const output = renderTable(rows, [columnsFor(rows, ['query'])[0]!, barColumn(rows, 'clicks', options)], options)
    expect(output.every(line => stringWidth(line) <= 80)).toBe(true)
    expect(stripVTControlCharacters(output.join('\n'))).toContain('12,480')
    expect(output.join('\n')).toContain('\x1B[36m')
  })

  it('only explains series gaps when gaps exist', () => {
    const rows = [{ label: 'docs', total: 12, points: [{ date: '2026-08-01', value: 12 }] }]
    const output = renderSparklines(rows, { start: '2026-08-01', end: '2026-08-01', unit: 'day' }, 'clicks', plain).join('\n')
    expect(output).toContain('12')
    expect(output).not.toMatch(/missing|No data|2026-08-01/)
  })

  it('aligns the zero axis when changes have different digit counts', () => {
    const rows = [{ change: -300 }, { change: 20 }]
    const output = renderTable(rows, [barColumn(rows, 'change', plain, true)], plain).slice(2)
    expect(output[0]!.indexOf('│')).toBe(output[1]!.indexOf('│'))
  })
})
