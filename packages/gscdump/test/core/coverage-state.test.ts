import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  countCoverageStates,
  coverageStateTagSql,
  KNOWN_COVERAGE_STATES,
  measureVerdictFreshness,
  parseCoverageState,
  verdictAgeCutoffs,
} from '../../src'

describe('parseCoverageState', () => {
  it.each([
    ['URL is unknown to Google', 'unknown_to_google'],
    ['Discovered - currently not indexed', 'discovered_not_indexed'],
    ['Crawled - currently not indexed', 'crawled_not_indexed'],
    ['Submitted and indexed', 'indexed'],
    ['Indexed, not submitted in sitemap', 'indexed'],
    ['Excluded by ‘noindex’ tag', 'noindex'],
    ['Excluded by \'noindex\' tag', 'noindex'],
    ['Duplicate, Google chose different canonical than user', 'duplicate_google_canonical'],
    ['  Soft 404  ', 'soft_404'],
  ])('reads %j as %s', (prose, tag) => {
    expect(parseCoverageState(prose)).toEqual({ _tag: tag })
  })

  it('keeps prose it cannot map', () => {
    expect(parseCoverageState('Blocked due to teapot (418)'))
      .toEqual({ _tag: 'unrecognized', coverageState: 'Blocked due to teapot (418)' })
  })

  it.each([null, undefined, '', '   '])('reads %j as not reported', (prose) => {
    expect(parseCoverageState(prose)).toEqual({ _tag: 'not_reported' })
  })

  it('maps every coverage string the issue canary knows', () => {
    const unrecognized = [...KNOWN_COVERAGE_STATES].filter(prose => parseCoverageState(prose)._tag === 'unrecognized')
    expect(unrecognized).toEqual([])
  })
})

describe('countCoverageStates', () => {
  it('keeps discovered and crawled URLs apart', () => {
    const counts = countCoverageStates([
      'Crawled - currently not indexed',
      'Discovered - currently not indexed',
      'Discovered - currently not indexed',
      'URL is unknown to Google',
      'Submitted and indexed',
      null,
    ])
    expect(counts).toMatchObject({
      crawled_not_indexed: 1,
      discovered_not_indexed: 2,
      unknown_to_google: 1,
      indexed: 1,
      not_reported: 1,
      noindex: 0,
    })
  })
})

describe('coverageStateTagSql', () => {
  it('tags rows in SQL exactly as the parser does', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE inspections (coverage_state TEXT)')
    const insert = db.prepare('INSERT INTO inspections (coverage_state) VALUES (?)')
    const prose = [
      ...KNOWN_COVERAGE_STATES,
      'Excluded by \'noindex\' tag',
      ' Submitted and indexed ',
      'Blocked due to teapot (418)',
      '',
      null,
    ]
    for (const value of prose)
      insert.run(value)

    const rows = db.prepare(`SELECT coverage_state, ${coverageStateTagSql('coverage_state')} AS tag FROM inspections`)
      .all() as Array<{ coverage_state: string | null, tag: string }>

    expect(rows.map(row => row.tag)).toEqual(rows.map(row => parseCoverageState(row.coverage_state)._tag))
  })
})

describe('measureVerdictFreshness', () => {
  it('reports the share of verdicts past each age', () => {
    expect(measureVerdictFreshness({ verdicts: 1487, olderThan7d: 1484, olderThan30d: 1231 })).toEqual({
      _tag: 'measured',
      verdicts: 1487,
      olderThan7d: 1484,
      olderThan30d: 1231,
      olderThan7dPercent: 99.8,
      olderThan30dPercent: 82.8,
    })
  })

  it('clamps an older bucket to the younger one', () => {
    expect(measureVerdictFreshness({ verdicts: 10, olderThan7d: 4, olderThan30d: 9 }))
      .toMatchObject({ olderThan7d: 4, olderThan30d: 4 })
  })

  it('reports zero percent when nothing was inspected', () => {
    expect(measureVerdictFreshness({ verdicts: 0, olderThan7d: 0, olderThan30d: 0 }))
      .toMatchObject({ olderThan7dPercent: 0, olderThan30dPercent: 0 })
  })
})

describe('verdictAgeCutoffs', () => {
  it('places each cutoff whole days before now', () => {
    expect(verdictAgeCutoffs(Date.parse('2026-09-30T12:00:00.000Z'))).toEqual({
      olderThan7d: '2026-09-23T12:00:00.000Z',
      olderThan30d: '2026-08-31T12:00:00.000Z',
    })
  })
})
