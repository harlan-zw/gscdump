import { describe, expect, it } from 'vitest'
import { hasDataForRange, queryDatesWithComparison } from '../src/api-queries'
import { createTestDb, seedTestData, setupSchema } from './_helpers'

describe('hasDataForRange', () => {
  it('returns true when data exists', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await hasDataForRange(db, 1, { startDate: '2024-01-10', endDate: '2024-01-12' })
    expect(result).toBe(true)
  })

  it('returns false when no data exists', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await hasDataForRange(db, 1, { startDate: '2025-01-01', endDate: '2025-01-10' })
    expect(result).toBe(false)
  })

  it('returns false for non-existent site', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await hasDataForRange(db, 999, { startDate: '2024-01-10', endDate: '2024-01-12' })
    expect(result).toBe(false)
  })

  it('returns true for partial date range overlap', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await hasDataForRange(db, 1, { startDate: '2024-01-11', endDate: '2024-01-20' })
    expect(result).toBe(true)
  })
})

describe('queryDatesWithComparison', () => {
  it('returns daily aggregated data', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDatesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
    )

    expect(result.current.length).toBe(3)
    expect(result.current[0].date).toBe('2024-01-10')
  })

  it('aggregates multiple paths per date', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDatesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-10' },
    )

    // Should aggregate /page1 (100 clicks) + /page2 (50 clicks)
    expect(result.current[0].clicks).toBe(150)
  })

  it('returns previous period data', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDatesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
      { startDate: '2024-01-01', endDate: '2024-01-03' },
    )

    expect(result.previous.length).toBe(3)
    expect(result.previous[0].date).toBe('2024-01-01')
  })

  it('calculates totals', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDatesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
    )

    expect(result.metadata.totals.current.clicks).toBeGreaterThan(0)
    expect(result.metadata.totals.current.impressions).toBeGreaterThan(0)
  })

  it('calculates percent differences', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDatesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
      { startDate: '2024-01-01', endDate: '2024-01-03' },
    )

    expect(result.metadata.totals.clicksPercent).toBeDefined()
    expect(result.metadata.totals.impressionsPercent).toBeDefined()
    expect(result.metadata.totals.ctrPercent).toBeDefined()
    expect(result.metadata.totals.positionPercent).toBeDefined()
  })

  it('returns empty previous when not provided', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDatesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
    )

    expect(result.previous).toHaveLength(0)
    expect(result.metadata.totals.previous.clicks).toBe(0)
  })

  it('sorts dates chronologically', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDatesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-12' },
    )

    expect(result.current[0].date).toBe('2024-01-10')
    expect(result.current[1].date).toBe('2024-01-11')
    expect(result.current[2].date).toBe('2024-01-12')
  })
})
