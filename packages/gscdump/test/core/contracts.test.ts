import type { GscSearchAnalyticsRequest, GscSearchAnalyticsResponse } from '../../src/contracts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { and, between, contains, date, eq, gsc, page, searchType, SearchTypes } from '../../src/query'

function readFixture<T>(name: string): T {
  const url = new URL(`../fixtures/contracts/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T
}

describe('public contracts', () => {
  it('accepts query-builder output as the canonical Search Analytics request fixture', () => {
    const fixture = readFixture<GscSearchAnalyticsRequest>('search-analytics-request')
    const body: GscSearchAnalyticsRequest = gsc
      .select(page)
      .where(and(
        between(date, '2026-04-01', '2026-04-30'),
        contains(page, '/docs/'),
        eq(searchType, SearchTypes.WEB),
      ))
      .limit(100)
      .offset(25)
      .toBody()

    expect(body).toEqual(fixture)
    expect('searchType' in body).toBe(false)
  })

  it('documents the normalized row response fixture used by host apps', () => {
    const response = readFixture<GscSearchAnalyticsResponse>('search-analytics-response')
    expect(response.rows?.[0]?.keys).toEqual(['https://example.com/docs/'])
  })
})
