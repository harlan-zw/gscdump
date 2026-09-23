import { describe, expect, it } from 'vitest'
import { planJobDates, resolveWindow } from '../src/sync-plan'

const LATEST = '2026-09-19'
const FLOOR = '2025-05-23'
const catchUp = resolveWindow({ full: false, latest: LATEST, floor: FLOOR })

describe('planJobDates', () => {
  it('starts a table with no history 28 days back, newest first', () => {
    const { dates } = planJobDates({ table: 'pages', window: catchUp, states: [], today: '2026-09-22', mode: 'resume' })
    expect(dates[0]).toBe(LATEST)
    expect(dates.at(-1)).toBe('2026-08-23')
    expect(dates).toHaveLength(28)
  })

  it('catches up from the oldest synced date and skips done dates', () => {
    const states = [
      { date: '2026-09-01', state: 'done' },
      { date: '2026-09-02', state: 'failed' },
      { date: '2026-01-10', state: 'done' },
    ]
    const plan = planJobDates({ table: 'pages', window: catchUp, states, today: '2026-09-22', mode: 'resume' })
    expect(plan.dates.at(-1)).toBe('2026-01-11')
    expect(plan.dates).toContain('2026-09-02')
    expect(plan.dates).not.toContain('2026-09-01')
    expect(plan.skippedDone).toBe(2)
  })

  it('drops failed hourly dates that Google no longer serves', () => {
    const states = [{ date: '2026-03-01', state: 'failed' }, { date: '2026-09-18', state: 'failed' }]
    const plan = planJobDates({ table: 'hourly_pages', window: catchUp, states, today: '2026-09-22', mode: 'resume' })
    expect(plan.dates).not.toContain('2026-03-01')
    expect(plan.dates).toContain('2026-09-18')
    expect(plan.dates.every(date => date >= '2026-09-12')).toBe(true)
  })

  it('ignores history older than Google\'s retention floor', () => {
    const states = [{ date: '2024-01-01', state: 'done' }, { date: '2025-06-01', state: 'done' }]
    const plan = planJobDates({ table: 'pages', window: catchUp, states, today: '2026-09-22', mode: 'resume' })
    expect(plan.dates.at(-1)).toBe('2025-06-02')
  })

  it('asks --full for 14 days past the retention floor', () => {
    const window = resolveWindow({ full: true, latest: LATEST, floor: FLOOR })
    expect(window).toEqual({ kind: 'range', start: '2025-05-09', end: LATEST })
  })

  it.each([
    ['force', ['2026-09-19', '2026-09-18']],
    ['retry-failed', ['2026-09-18']],
  ] as const)('in %s mode fetches %j', (mode, expected) => {
    const window = resolveWindow({ start: '2026-09-18', full: false, latest: LATEST, floor: FLOOR })
    const states = [{ date: '2026-09-19', state: 'done' }, { date: '2026-09-18', state: 'failed' }]
    expect(planJobDates({ table: 'pages', window, states, today: '2026-09-22', mode }).dates).toEqual(expected)
  })
})
