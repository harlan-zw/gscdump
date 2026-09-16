import { describe, expect, it } from 'vitest'
// @ts-expect-error the perf harness is plain JavaScript, with no types
import { renderReport } from '../scripts/perf/report.mjs'

interface BenchmarkInput {
  id: string
  kind: 'count' | 'time'
  unit: string
  headMin: number
  parentMin: number
  controlPercent: number
  verified?: boolean
}

function measurement(benchmarks: BenchmarkInput[], paired = true) {
  return {
    harness: 1,
    paired,
    benchmarks: benchmarks.map(benchmark => ({
      id: benchmark.id,
      kind: benchmark.kind,
      unit: benchmark.unit,
      repeats: 9,
      head: { min: benchmark.headMin, median: benchmark.headMin },
      parent: { min: benchmark.parentMin, median: benchmark.parentMin },
      control: { min: benchmark.headMin, median: benchmark.headMin },
      deltaPercent: (benchmark.headMin - benchmark.parentMin) / benchmark.parentMin * 100,
      controlPercent: benchmark.controlPercent,
      verified: benchmark.verified ?? true,
    })),
  }
}

function timed(headMin: number, parentMin: number, controlPercent: number): BenchmarkInput {
  return { controlPercent, headMin, id: 'engine/decode', kind: 'time', parentMin, unit: 'ms' }
}

describe('perf report', () => {
  it('calls a timed change nothing when it stays inside the noise the run measured', () => {
    // 8% slower reads as noise once the same build moved 5% against itself.
    const report = renderReport(measurement([timed(108, 100, 5)]))
    expect(report).toContain('✅ **No clear performance change.**')
    expect(report).not.toContain('🔴')
  })

  it('calls the same change a regression when the run was quiet', () => {
    const report = renderReport(measurement([timed(108, 100, 0.5)]))
    expect(report).toContain('🔴')
    expect(report).toContain('grew by 8.00 ms')
  })

  it('holds a timed change to the 5% floor however quiet the run was', () => {
    const report = renderReport(measurement([timed(103, 100, 0)]))
    expect(report).toContain('✅ **No clear performance change.**')
  })

  it('reports any movement in a count benchmark, because a count carries no noise', () => {
    const report = renderReport(measurement([
      { controlPercent: 0, headMin: 1_010_000, id: 'engine/dist-bytes', kind: 'count', parentMin: 1_000_000, unit: 'bytes' },
    ]))
    expect(report).toContain('🔴')
    expect(report).toContain('engine/dist-bytes')
  })

  it('refuses to read a benchmark whose sides disagree on their output', () => {
    const report = renderReport(measurement([{ ...timed(140, 100, 0.2), verified: false }]))
    expect(report).toContain('no usable reading')
    expect(report).not.toContain('🔴')
  })

  it('warns that a lockfile change invalidates the comparison', () => {
    const report = renderReport(measurement([timed(100, 100, 0.1)], false))
    expect(report).toContain('pnpm-lock.yaml')
  })

  it('names an improvement when the change beats the noise downwards', () => {
    const report = renderReport(measurement([timed(80, 100, 1)]))
    expect(report).toContain('🟢')
    expect(report).toContain('fell by 20.00 ms')
  })
})
