import { describe, expect, it } from 'vitest'
import { exportToCSV, parsePeriod, progressBar, toCSV } from '../src/utils'

describe('parsePeriod', () => {
  it('should parse days correctly', () => {
    expect(parsePeriod('7d')).toEqual({ amount: 7, unit: 'days' })
    expect(parsePeriod('30d')).toEqual({ amount: 30, unit: 'days' })
    expect(parsePeriod('90d')).toEqual({ amount: 90, unit: 'days' })
    expect(parsePeriod('180d')).toEqual({ amount: 180, unit: 'days' })
  })

  it('should parse months correctly', () => {
    expect(parsePeriod('1m')).toEqual({ amount: 1, unit: 'months' })
    expect(parsePeriod('3m')).toEqual({ amount: 3, unit: 'months' })
    expect(parsePeriod('6m')).toEqual({ amount: 6, unit: 'months' })
    expect(parsePeriod('12m')).toEqual({ amount: 12, unit: 'months' })
  })

  it('should parse years correctly', () => {
    expect(parsePeriod('1y')).toEqual({ amount: 1, unit: 'years' })
    expect(parsePeriod('2y')).toEqual({ amount: 2, unit: 'years' })
  })

  it('should be case insensitive', () => {
    expect(parsePeriod('7D')).toEqual({ amount: 7, unit: 'days' })
    expect(parsePeriod('3M')).toEqual({ amount: 3, unit: 'months' })
    expect(parsePeriod('1Y')).toEqual({ amount: 1, unit: 'years' })
  })

  it('should return null for invalid formats', () => {
    expect(parsePeriod('')).toBeNull()
    expect(parsePeriod('7')).toBeNull()
    expect(parsePeriod('d')).toBeNull()
    expect(parsePeriod('7x')).toBeNull()
    expect(parsePeriod('abc')).toBeNull()
    expect(parsePeriod('7days')).toBeNull()
  })

  it('should return null for invalid amounts', () => {
    expect(parsePeriod('0d')).toBeNull()
    expect(parsePeriod('-1d')).toBeNull()
  })

  it('should return null for periods over 450 days', () => {
    expect(parsePeriod('451d')).toBeNull()
    expect(parsePeriod('500d')).toBeNull()
    // But months/years over 450 days equivalent should work
    expect(parsePeriod('16m')).toEqual({ amount: 16, unit: 'months' })
    expect(parsePeriod('2y')).toEqual({ amount: 2, unit: 'years' })
  })
})

describe('progressBar', () => {
  it('should generate progress bar', () => {
    const bar = progressBar(1, 4, 'test')
    expect(bar).toContain('1/4')
    expect(bar).toContain('test')
    expect(bar).toContain('█')
  })

  it('should show full bar at 100%', () => {
    const bar = progressBar(4, 4, 'complete')
    expect(bar).toContain('4/4')
    expect(bar).not.toContain('░') // No empty blocks
  })

  it('should show partial progress', () => {
    const bar = progressBar(2, 4, 'half')
    expect(bar).toContain('2/4')
    expect(bar).toContain('█')
    expect(bar).toContain('░')
  })
})

describe('toCSV', () => {
  it('should convert array to CSV', () => {
    const data = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]
    const csv = toCSV(data, ['name', 'age'])
    expect(csv).toBe('name,age\nAlice,30\nBob,25')
  })

  it('should handle missing values', () => {
    const data = [
      { name: 'Alice', age: 30 },
      { name: 'Bob' },
    ]
    const csv = toCSV(data, ['name', 'age'])
    expect(csv).toBe('name,age\nAlice,30\nBob,')
  })

  it('should escape commas in values', () => {
    const data = [{ name: 'Smith, John', age: 30 }]
    const csv = toCSV(data, ['name', 'age'])
    expect(csv).toBe('name,age\n"Smith, John",30')
  })

  it('should escape quotes in values', () => {
    const data = [{ name: 'Say "Hello"', age: 30 }]
    const csv = toCSV(data, ['name', 'age'])
    expect(csv).toBe('name,age\n"Say ""Hello""",30')
  })

  it('should handle newlines in values', () => {
    const data = [{ name: 'Line1\nLine2', age: 30 }]
    const csv = toCSV(data, ['name', 'age'])
    expect(csv).toBe('name,age\n"Line1\nLine2",30')
  })

  it('should handle null and undefined', () => {
    const data = [{ name: null, age: undefined }]
    const csv = toCSV(data, ['name', 'age'])
    expect(csv).toBe('name,age\n,')
  })
})

describe('exportToCSV', () => {
  it('should export pages data', () => {
    const output = {
      pages: {
        data: [
          { url: 'https://example.com/', clicks: 100, impressions: 1000, ctr: 0.1, position: 5 },
        ],
      },
    }
    const csv = exportToCSV(output)
    expect(csv).toContain('# Pages')
    expect(csv).toContain('url,clicks,impressions,ctr,position')
    expect(csv).toContain('https://example.com/')
  })

  it('should export keywords data', () => {
    const output = {
      keywords: {
        current: [
          { query: 'test query', clicks: 50, impressions: 500, ctr: 0.1, position: 3 },
        ],
      },
    }
    const csv = exportToCSV(output)
    expect(csv).toContain('# Keywords')
    expect(csv).toContain('query,clicks,impressions,ctr,position')
    expect(csv).toContain('test query')
  })

  it('should export countries data', () => {
    const output = {
      countries: {
        current: [
          { country: 'United States', clicks: 200, impressions: 2000, ctr: 0.1, position: 4 },
        ],
      },
    }
    const csv = exportToCSV(output)
    expect(csv).toContain('# Countries')
    expect(csv).toContain('country,clicks,impressions,ctr,position')
  })

  it('should export devices data', () => {
    const output = {
      devices: {
        current: [
          { device: 'desktop', clicks: 150, impressions: 1500, ctr: 0.1, position: 5 },
        ],
      },
    }
    const csv = exportToCSV(output)
    expect(csv).toContain('# Devices')
    expect(csv).toContain('device,clicks,impressions,ctr,position')
  })

  it('should export multiple sections', () => {
    const output = {
      pages: { data: [{ url: 'test', clicks: 1, impressions: 10, ctr: 0.1, position: 1 }] },
      keywords: { current: [{ query: 'test', clicks: 1, impressions: 10, ctr: 0.1, position: 1 }] },
    }
    const csv = exportToCSV(output)
    expect(csv).toContain('# Pages')
    expect(csv).toContain('# Keywords')
  })

  it('should handle empty output', () => {
    const csv = exportToCSV({})
    expect(csv).toBe('')
  })
})
