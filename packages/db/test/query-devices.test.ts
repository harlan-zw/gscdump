import { describe, expect, it } from 'vitest'
import { queryDevicesWithComparison } from '../src/api-queries'
import { createTestDb, seedTestData, setupSchema } from './_helpers'

describe('queryDevicesWithComparison', () => {
  it('returns device breakdown sorted by clicks', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDevicesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current).toHaveLength(2)
    expect(result.current[0].device).toBe('MOBILE')
    expect(result.current[0].clicks).toBe(310) // 150 + 160
    expect(result.current[1].device).toBe('DESKTOP')
    expect(result.current[1].clicks).toBe(100)
  })

  it('returns previous period data', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDevicesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
      { startDate: '2024-01-01', endDate: '2024-01-01' },
    )

    expect(result.previous.length).toBeGreaterThan(0)
    expect(result.previous[0].device).toBe('MOBILE')
    expect(result.previous[0].clicks).toBe(120)
  })

  it('includes metadata counts', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDevicesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
      { startDate: '2024-01-01', endDate: '2024-01-01' },
    )

    expect(result.metadata?.currentCount).toBe(2)
    expect(result.metadata?.previousCount).toBe(1)
  })

  it('converts metrics from DB format', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDevicesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-10' },
    )

    // CTR stored as 1000, should return 0.1
    expect(result.current[0].ctr).toBeCloseTo(0.1, 2)
    // Position stored as 500, should return 5.0
    expect(result.current[0].position).toBeCloseTo(5, 1)
  })

  it('sets keys to null', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDevicesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current[0].keys).toBeNull()
  })

  it('returns empty arrays when no data', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryDevicesWithComparison(
      db,
      999,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current).toHaveLength(0)
    expect(result.metadata?.currentCount).toBe(0)
  })
})
