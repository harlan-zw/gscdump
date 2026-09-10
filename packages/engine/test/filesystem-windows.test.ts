import { createFilesystemDataSource } from '@gscdump/engine/filesystem'
import { describe, expect, it, vi } from 'vitest'

// Exercise Windows path rules on every runner. Real file operations run in Windows CI.
vi.mock('node:path', async (importOriginal) => {
  const { win32 } = await importOriginal<typeof import('node:path')>()
  return { ...win32, default: win32 }
})

describe('filesystem paths on Windows', () => {
  it.each([
    ['C:\\gscdump data', 'pages/day.parquet', 'C:/gscdump data/pages/day.parquet'],
    ['C:\\gscdump data\\', 'pages/day.parquet', 'C:/gscdump data/pages/day.parquet'],
    ['C:\\', 'pages/day.parquet', 'C:/pages/day.parquet'],
    ['\\\\server\\share\\gscdump data', 'pages/day.parquet', '//server/share/gscdump data/pages/day.parquet'],
    ['C:\\gscdump data', 'pages\\daily/day.parquet', 'C:/gscdump data/pages/daily/day.parquet'],
  ])('resolves %s and %s for local queries', (rootDir, key, expected) => {
    const source = createFilesystemDataSource({ rootDir })

    expect(source.uri!(key)).toBe(expected)
  })

  it.each([
    '../outside.parquet',
    '..\\outside.parquet',
    'pages\\..\\..\\outside.parquet',
    'C:\\gscdump data-other\\outside.parquet',
    'D:\\outside.parquet',
    '\\\\server\\share\\outside.parquet',
  ])('rejects a path outside the Store: %s', (key) => {
    const source = createFilesystemDataSource({ rootDir: 'C:\\gscdump data' })

    expect(() => source.uri!(key)).toThrow(/escapes root/)
  })
})
