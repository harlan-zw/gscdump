import { describe, expect, it } from 'vitest'
import { queryPages, queryPagesWithComparison } from '../src/api-queries'
import { createTestDb, seedTestData, setupSchema } from './_helpers'

describe('queryPages', () => {
  it('returns aggregated page data sorted by clicks', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPages(db, 1, { startDate: '2024-01-10', endDate: '2024-01-12' })

    expect(result).toHaveLength(2)
    expect(result[0].page).toBe('/page1')
    expect(result[0].clicks).toBe(330) // 100 + 120 + 110
    expect(result[1].page).toBe('/page2')
    expect(result[1].clicks).toBe(105) // 50 + 55
  })

  it('converts metrics from DB format', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPages(db, 1, { startDate: '2024-01-10', endDate: '2024-01-10' })

    // CTR stored as 1000 (0.1 * 10000), should be returned as 0.1
    expect(result[0].ctr).toBeCloseTo(0.1, 2)
    // Position stored as 500 (5.0 * 100), should be returned as 5.0
    expect(result[0].position).toBeCloseTo(5, 1)
  })

  it('returns empty array for date range with no data', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPages(db, 1, { startDate: '2025-01-01', endDate: '2025-01-10' })
    expect(result).toHaveLength(0)
  })
})

describe('queryPagesWithComparison', () => {
  it('returns current and previous period data', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPagesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
      { startDate: '2024-01-01', endDate: '2024-01-03' },
    )

    expect(result.current.length).toBeGreaterThan(0)
    expect(result.previous.length).toBeGreaterThan(0)
    expect(result.metadata?.currentCount).toBe(result.current.length)
  })

  it('calculates percent difference', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPagesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
      { startDate: '2024-01-01', endDate: '2024-01-03' },
    )

    const page1 = result.current.find(p => p.page === '/page1')
    expect(page1?.clicksPercent).toBeDefined()
    expect(page1?.prevClicks).toBe(255) // 80 + 85 + 90
  })

  it('marks lost pages', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPagesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
      { startDate: '2024-01-01', endDate: '2024-01-03' },
    )

    const lostPage = result.previous.find(p => p.page === '/lost-page')
    expect(lostPage?.lost).toBe(true)
  })

  it('includes top keyword for each page', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPagesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    const page1 = result.current.find(p => p.page === '/page1')
    expect(page1?.keyword).toBeDefined()
  })

  it('works without previous period', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryPagesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
    )

    expect(result.current.length).toBeGreaterThan(0)
    expect(result.previous).toHaveLength(0)
  })
})
