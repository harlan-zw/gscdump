import { describe, expect, it } from 'vitest'
import { queryCountriesWithComparison } from '../src/api-queries'
import { createTestDb, seedTestData, setupSchema } from './_helpers'

describe('queryCountriesWithComparison', () => {
  it('returns country breakdown sorted by clicks', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current.length).toBeGreaterThan(0)
    expect(result.current[0].countryCodeGsc).toBe('usa')
    expect(result.current[0].clicks).toBe(420) // 200 + 220
  })

  it('includes country name and codes', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current[0].countryCodeGsc).toBeDefined()
    expect(result.current[0].country).toBeDefined()
    expect(result.current[0].countryCode).toBeDefined()
  })

  it('returns previous period data', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
      { startDate: '2024-01-01', endDate: '2024-01-01' },
    )

    expect(result.previous.length).toBeGreaterThan(0)
    expect(result.previous[0].clicks).toBe(180)
  })

  it('respects limit parameter', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
      undefined,
      1,
    )

    expect(result.current).toHaveLength(1)
  })

  it('defaults to limit of 5', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current.length).toBeLessThanOrEqual(5)
  })

  it('includes metadata counts', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.metadata?.currentCount).toBeDefined()
    expect(result.metadata?.previousCount).toBeDefined()
  })

  it('converts metrics from DB format', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-10' },
    )

    // CTR stored as 1000, should return 0.1
    expect(result.current[0].ctr).toBeCloseTo(0.1, 2)
    // Position stored as 400, should return 4.0
    expect(result.current[0].position).toBeCloseTo(4, 1)
  })

  it('sets keys to null', async () => {
    const { db0, db } = createTestDb()
    await setupSchema(db0)
    await seedTestData(db)

    const result = await queryCountriesWithComparison(
      db,
      1,
      { startDate: '2024-01-10', endDate: '2024-01-11' },
    )

    expect(result.current[0].keys).toBeNull()
  })
})
