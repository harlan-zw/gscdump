import type { TrajectoryDay } from '../src/analyzers/trajectory'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { describe, expect, it } from 'vitest'
import { analyzeTrajectory, IMPRESSIONS_OVERCOUNT_THROUGH } from '../src/analyzers/trajectory'
import { defaultAnalyzerRegistry } from '../src/default-registry'
import { createInMemoryQuerySource } from '../src/source'
import skilldDaily from './fixtures/skilld-daily-2026-09-26.json'

const MS_PER_DAY = 86_400_000

/** Build a gap-free daily series. `shape(i)` returns clicks and impressions for day `i`. */
function series(
  start: string,
  days: number,
  shape: (i: number) => { clicks: number, impressions: number },
): TrajectoryDay[] {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.parse(start) + i * MS_PER_DAY).toISOString().slice(0, 10),
    ...shape(i),
  }))
}

/** Deterministic wobble in [-1, 1], so fixtures stay stable without a random source. */
const wobble = (i: number): number => Math.sin(i * 12.9898) * 0.5 + Math.cos(i * 4.1414) * 0.5

describe('analyzeTrajectory', () => {
  it('names the skilld.dev record a launch honeymoon then cliff', () => {
    const result = analyzeTrajectory(skilldDaily)

    expect(result.classification._tag).toBe('launch-honeymoon-then-cliff')
    expect(result.firstDataDate).toBe('2026-04-15')
    expect(result.lastDataDate).toBe('2026-09-26')
    // Clicks carry the read: impressions were over-counted through 2026-04-27.
    expect(result.basis).toMatchObject({ _tag: 'clicks', reason: 'impressions-overcount-window' })
    expect(result.peak.startDate <= '2026-04-28' && result.peak.endDate >= '2026-04-28').toBe(true)
    expect(result.peak.clicks).toBeGreaterThan(100)
    expect(result.peak.impressions).toBeGreaterThan(25_000)
    expect(result.latest).toMatchObject({ endDate: '2026-09-26', clicks: 0, impressions: expect.any(Number) })
    expect(result.latestToPeakRatio).toBe(0)
    expect(result.caveats).toEqual([
      expect.objectContaining({ _tag: 'impressions-overcount', throughDate: IMPRESSIONS_OVERCOUNT_THROUGH }),
    ])
  })

  it('reports how fast the skilld climb and drop were', () => {
    const { classification } = analyzeTrajectory(skilldDaily)
    if (classification._tag !== 'launch-honeymoon-then-cliff')
      throw new Error(`unexpected ${classification._tag}`)
    expect(classification.climbDays).toBeLessThanOrEqual(56)
    expect(classification.dropDays).toBeLessThanOrEqual(14)
  })

  it('reads a flat site as steady', () => {
    const daily = series('2026-05-01', 200, i => ({
      clicks: Math.round(40 + wobble(i) * 4),
      impressions: Math.round(2000 + wobble(i + 3) * 200),
    }))
    const result = analyzeTrajectory(daily)

    expect(result.classification._tag).toBe('steady')
    expect(result.latestToPeakRatio).toBeGreaterThan(0.8)
    expect(result.basis._tag).toBe('impressions')
    expect(result.caveats).toEqual([])
  })

  it('reads a steady climb as growing', () => {
    const daily = series('2026-01-01', 200, i => ({
      clicks: Math.round(10 + i * 0.6 + wobble(i)),
      impressions: Math.round(500 + i * 25 + wobble(i) * 20),
    }))
    const result = analyzeTrajectory(daily)

    expect(result.classification._tag).toBe('growing')
    expect(result.latestToPeakRatio).toBeGreaterThanOrEqual(0.9)
    expect(result.weeksSincePeak).toBe(0)
  })

  it('reads a slow slide over months as gradual decline, not a cliff', () => {
    // Established site: flat for 12 weeks, then 14 weeks of steady loss to about 35% of peak.
    const daily = series('2026-01-01', 182, (i) => {
      const level = i < 84 ? 1 : Math.max(0.35, 1 - (i - 84) * 0.0066)
      return {
        clicks: Math.round(60 * level + wobble(i) * 3),
        impressions: Math.round(3000 * level + wobble(i + 1) * 100),
      }
    })
    const result = analyzeTrajectory(daily)

    expect(result.classification._tag).toBe('gradual-decline')
    expect(result.latestToPeakRatio).toBeGreaterThan(0.25)
    expect(result.latestToPeakRatio).toBeLessThan(0.7)
  })

  it('does not call an established site that drops fast a launch honeymoon', () => {
    const daily = series('2026-01-01', 140, (i) => {
      const level = i < 90 ? 1 : 0.02
      return { clicks: Math.round(50 * level), impressions: Math.round(2500 * level) }
    })
    expect(analyzeTrajectory(daily).classification._tag).toBe('sudden-drop')
  })

  it('does not call a recovery a cliff', () => {
    const daily = series('2026-03-01', 200, (i) => {
      const level = i < 20 ? 0.1 + i * 0.045 : i < 40 ? Math.max(0.03, 1 - (i - 20) * 0.1) : 0.03 + Math.min(1, (i - 40) / 100)
      return { clicks: Math.round(50 * level), impressions: Math.round(3000 * level) }
    })
    const result = analyzeTrajectory(daily)
    expect(result.classification._tag).not.toBe('launch-honeymoon-then-cliff')
  })

  it('treats missing days as zero, not as absent', () => {
    const daily = analyzeTrajectory(skilldDaily.filter(row => row.clicks > 0 || row.impressions > 0))
    expect(daily.classification._tag).toBe('launch-honeymoon-then-cliff')
  })

  it('returns insufficient-data for a record under four weeks', () => {
    const result = analyzeTrajectory(series('2026-06-01', 20, () => ({ clicks: 5, impressions: 100 })))
    expect(result.classification).toEqual({ _tag: 'insufficient-data', reason: 'too-few-days', days: 20 })
    expect(result.latestToPeakRatio).toBeNull()
  })

  it('returns insufficient-data for an empty record', () => {
    const result = analyzeTrajectory([])
    expect(result.classification).toMatchObject({ _tag: 'insufficient-data', reason: 'too-few-days', days: 0 })
    expect(result.firstDataDate).toBeNull()
  })

  it('returns insufficient-data when the record has almost no traffic', () => {
    const result = analyzeTrajectory(series('2026-06-01', 100, i => ({ clicks: 0, impressions: i % 30 === 0 ? 2 : 0 })))
    expect(result.classification).toMatchObject({ _tag: 'insufficient-data', reason: 'no-traffic' })
  })

  it('uses impressions when the record sits wholly after the over-count fix', () => {
    const result = analyzeTrajectory(series('2026-05-01', 100, i => ({
      clicks: 1,
      impressions: Math.round(400 + wobble(i) * 20),
    })))
    expect(result.basis._tag).toBe('impressions')
    expect(result.caveats).toEqual([])
  })
})

describe('trajectory analyzer', () => {
  it('runs against a source and returns the same classification', async () => {
    const source = createInMemoryQuerySource({
      queryRows: () => skilldDaily.map(row => ({ ...row, ctr: 0, position: 0 })),
    })
    const out = await runAnalyzerFromSource(
      source,
      { type: 'trajectory', startDate: '2026-04-15', endDate: '2026-09-26' },
      defaultAnalyzerRegistry,
    )
    const [result] = out.results as unknown as Array<{ classification: { _tag: string } }>
    expect(result?.classification._tag).toBe('launch-honeymoon-then-cliff')
  })
})
