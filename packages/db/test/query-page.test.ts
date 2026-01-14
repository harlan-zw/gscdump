import { describe, expect, it } from 'vitest'
import { queryPage } from '../src/api-queries'
import { createTestDb, seedTestData, setupSchema } from './_helpers'

describe('queryPage', () => {
  it('returns daily trend for page', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-12' }, '/page1')

    expect(result.dates).toHaveLength(3)
    expect(result.dates[0].date).toBe('2024-01-10')
    expect(result.dates[0].clicks).toBe(100)
  })

  it('returns top keywords for page', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, '/page1')

    expect(result.keywords.length).toBeGreaterThan(0)
    expect(result.keywords[0].keyword).toBe('test keyword')
  })

  it('limits keywords to 5', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, '/page1')

    expect(result.keywords.length).toBeLessThanOrEqual(5)
  })

  it('sorts keywords by clicks', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, '/page1')

    // test keyword has 90 clicks (40 + 50), another keyword has 20
    expect(result.keywords[0].keyword).toBe('test keyword')
    if (result.keywords.length > 1) {
      expect(result.keywords[0].clicks).toBeGreaterThanOrEqual(result.keywords[1].clicks)
    }
  })

  it('returns empty for non-existent page', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, '/nonexistent')

    expect(result.dates).toHaveLength(0)
    expect(result.keywords).toHaveLength(0)
  })

  it('converts metrics from DB format', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-10' }, '/page1')

    // CTR stored as 1000, should return 0.1
    expect(result.dates[0].ctr).toBeCloseTo(0.1, 2)
    // Position stored as 500, should return 5.0
    expect(result.dates[0].position).toBeCloseTo(5, 1)
  })

  it('sorts dates chronologically', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-12' }, '/page1')

    expect(result.dates[0].date).toBe('2024-01-10')
    expect(result.dates[1].date).toBe('2024-01-11')
    expect(result.dates[2].date).toBe('2024-01-12')
  })

  it('aggregates keyword clicks across dates', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPage(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, '/page1')

    const testKw = result.keywords.find(k => k.keyword === 'test keyword')
    // 40 + 50 from two days
    expect(testKw?.clicks).toBe(90)
  })
})
