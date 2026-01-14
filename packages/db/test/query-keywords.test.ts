import { describe, expect, it } from 'vitest'
import { queryKeyword, queryKeywordsWithComparison } from '../src/api-queries'
import { createTestDb, seedTestData, setupSchema } from './_helpers'

describe('queryKeywordsWithComparison', () => {
  it('returns keyword data sorted by clicks', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeywordsWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current.length).toBeGreaterThan(0)
    expect(result.current[0].keyword).toBe('test keyword')
    expect(result.current[0].clicks).toBe(110) // 50 + 60
  })

  it('includes top page for each keyword', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeywordsWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    const testKw = result.current.find(k => k.keyword === 'test keyword')
    expect(testKw?.page).toBe('/page1')
  })

  it('calculates position and ctr percent changes', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeywordsWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
      { startDate: '2024-01-01', endDate: '2024-01-01' },
    )

    const testKw = result.current.find(k => k.keyword === 'test keyword')
    expect(testKw?.positionPercent).toBeDefined()
    expect(testKw?.ctrPercent).toBeDefined()
    expect(testKw?.prevPosition).toBeDefined()
    expect(testKw?.prevCtr).toBeDefined()
  })

  it('marks lost keywords', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeywordsWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
      { startDate: '2024-01-01', endDate: '2024-01-01' },
    )

    const lostKw = result.previous.find(k => k.keyword === 'lost keyword')
    expect(lostKw?.lost).toBe(true)
    expect(lostKw?.prevClicks).toBe(15)
  })

  it('converts metrics from DB format', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeywordsWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-10' },
    )

    const testKw = result.current.find(k => k.keyword === 'test keyword')
    // CTR stored as 1000, should return 0.1
    expect(testKw?.ctr).toBeCloseTo(0.1, 2)
    // Position stored as 300, should return 3.0
    expect(testKw?.position).toBeCloseTo(3, 1)
  })
})

describe('queryKeyword', () => {
  it('returns daily trend for keyword', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeyword(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, 'test keyword')

    expect(result.dates).toHaveLength(2)
    expect(result.dates[0].date).toBe('2024-01-10')
    expect(result.dates[0].clicks).toBe(50)
  })

  it('returns top pages for keyword', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeyword(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, 'test keyword')

    expect(result.pages.length).toBeGreaterThan(0)
    expect(result.pages[0].page).toBe('/page1')
  })

  it('limits pages to 5', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeyword(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, 'test keyword')

    expect(result.pages.length).toBeLessThanOrEqual(5)
  })

  it('returns empty for non-existent keyword', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryKeyword(db, 1, { startDate: '2024-01-10', endDate: '2024-01-11' }, 'nonexistent')

    expect(result.dates).toHaveLength(0)
    expect(result.pages).toHaveLength(0)
  })
})
