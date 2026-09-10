import type { CommandDef } from 'citty'
import { runCommand } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeCommand } from '../../src/commands/analyze'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

const boundary = vi.hoisted(() => ({ result: { results: [] as Record<string, unknown>[], meta: {} as Record<string, unknown> } }))
vi.mock('../../src/analysis-local', () => ({
  resolveAnalysisSource: vi.fn(async args => ({
    siteUrl: 'sc-domain:example.com',
    isLive: false,
    format: args.json ? 'json' : args.format ?? 'table',
    runAnalysis: async () => boundary.result,
  })),
}))

const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
afterEach(() => {
  vi.restoreAllMocks()
  if (columnsDescriptor)
    Object.defineProperty(process.stdout, 'columns', columnsDescriptor)
  else
    Reflect.deleteProperty(process.stdout, 'columns')
})

async function output(name: string, args: string[] = []) {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...values) => lines.push(values.join(' ')))
  const runtime = createCliRuntime({ environment: { NO_COLOR: '1' } })
  runtime.colorEnabled = false
  runtime.logger.level = -999
  const command = (analyzeCommand.subCommands as Record<string, CommandDef>)[name]!
  await runWithCliRuntime(runtime, () => runCommand(command, { rawArgs: args }))
  return lines.join('\n')
}

describe('analyzer human output', () => {
  it('formats CTR as a rate with useful precision', async () => {
    boundary.result = { results: [{ page: '/docs', clicks: 12, impressions: 1000, ctr: 0.012 }], meta: {} }
    const text = await output('opportunity')
    expect(text).toContain('1.20%')
    expect(text).not.toContain('+1%')
  })

  it('preserves the brand summary denominator and total count', async () => {
    boundary.result = { results: [{ query: 'example', clicks: 4800, segment: 'brand' }], meta: {
      total: 500,
      summary: { brandClicks: 4800, nonBrandClicks: 7200, brandShare: 0.4 },
    } }
    const text = await output('brand', ['--brand-terms', 'example'])
    expect(text).toContain('40.0%')
    expect(text).toContain('12,000 clicks in returned rows')
    expect(text).toContain('Showing 1 of 500')
  })

  it('preserves weeks missing from every series', async () => {
    boundary.result = { results: [{ page: '/docs', totalClicks: 100, series: [
      { week: '2026-08-03', clicks: 0 },
      { week: '2026-08-17', clicks: 100 },
    ] }], meta: { startDate: '2026-08-03', endDate: '2026-08-23' } }
    const text = await output('trends')
    expect(text).toContain('▁·█')
    expect(text).toContain('No data')
    expect(text).toContain('2026-08-03')
  })

  it('stacks long labels without losing exact values at 40 columns', async () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 40 })
    boundary.result = { results: [{ page: `https://example.com/${'文档/'.repeat(30)}`, clicks: 12480, ctr: 0.012 }], meta: {} }
    const text = await output('opportunity')
    expect(text).toContain('12,480')
    expect(text).toContain('1.20%')
    expect(text.split('\n').every(line => [...line].length <= 40)).toBe(true)
  })

  it('retains every field in machine output', async () => {
    boundary.result = { results: [{ query: 'example', clicks: 12, ctr: 0.012 }], meta: { summary: { clicks: 12 } } }
    expect(JSON.parse(await output('opportunity', ['--json']))).toEqual(boundary.result)
    expect(await output('opportunity', ['--format', 'csv'])).toBe('query,clicks,ctr\nexample,12,0.012')
  })

  it('keeps empty results visible on stdout', async () => {
    boundary.result = { results: [], meta: {} }
    expect(await output('opportunity')).toContain('No results for this period.')
  })
  it('shows missing months and short-history limitations', async () => {
    boundary.result = { results: [{ month: '2026-01', value: 800 }, { month: '2026-03', value: 1000 }], meta: { insufficientData: true } }
    const text = await output('seasonality', ['--start', '2026-01-01', '--end', '2026-03-31'])
    expect(text).toContain('2026-02')
    expect(text).toContain('n/a')
    expect(text).toContain('Fewer than 12 months available.')
  })

  it('keeps a zero baseline explicit for movers without weekly data', async () => {
    boundary.result = { results: [{ keyword: 'example', recentClicks: 100, baselineClicks: 0, clicksChange: 100, clicksChangePercent: 100 }], meta: {} }
    const text = await output('movers', ['--prev-start', '2026-07-01', '--prev-end', '2026-07-28'])
    expect(text).toContain('+100')
    expect(text.replace(/\s+/g, ' ')).toContain('previous clicks: 0.')
    expect(text).not.toContain('+100%')
    expect(text).toContain('Weekly data unavailable.')
  })

  it('rejects unsupported output formats', async () => {
    await expect(output('opportunity', ['--format', 'yaml'])).rejects.toThrow('Invalid --format')
  })
  it('preserves available weekly mover series across both periods', async () => {
    boundary.result = { results: [{ keyword: 'example', recentClicks: 200, baselineClicks: 100, clicksChange: 100, series: [
      { week: '2026-08-03', clicks: 100 },
      { week: '2026-08-10', clicks: 200 },
    ] }], meta: {} }
    const text = await output('movers', ['--start', '2026-08-10', '--end', '2026-08-16', '--prev-start', '2026-08-03', '--prev-end', '2026-08-09'])
    expect(text).toContain('▁█')
    expect(text).toContain('300')
  })
})
