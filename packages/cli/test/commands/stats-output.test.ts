import type { ManifestEntry } from '../../src/local-store'
import { filesystemStats } from '@gscdump/engine/filesystem'
import { runCommand } from 'citty'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { statsCommand } from '../../src/commands/stats'

const mocks = vi.hoisted(() => {
  const store = {
    dataDir: '/fixture/data',
    userId: 'local',
    siteIdFor: vi.fn(),
    engine: {
      listAll: vi.fn(),
      getWatermarks: vi.fn(),
    },
  }
  return { store }
})

vi.mock('@gscdump/engine/filesystem', () => ({
  filesystemStats: vi.fn(),
}))
vi.mock('../../src/context', () => ({
  createCommandContext: vi.fn(async () => ({ store: mocks.store })),
}))

function entry(siteId: string): ManifestEntry {
  return {
    userId: 'local',
    siteId,
    table: 'pages',
    partition: '2026-08-01',
    objectKey: `fixture/${siteId}/pages.parquet`,
    rowCount: 5,
    bytes: 100,
    createdAt: 0,
  }
}

beforeEach(() => {
  mocks.store.engine.listAll.mockResolvedValue([])
  mocks.store.engine.getWatermarks.mockResolvedValue([{
    table: 'pages',
    siteId: 'd_example.com',
    oldestDateSynced: '2026-08-01',
    newestDateSynced: '2026-08-28',
    lastSyncAt: 0,
  }])
  mocks.store.siteIdFor.mockImplementation((site: string) => site)
  vi.mocked(filesystemStats).mockResolvedValue({ files: 0, bytes: 0 })
})

afterEach(() => vi.restoreAllMocks())

it('shows hosts in human watermarks and retains Site IDs in JSON', async () => {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  await runCommand(statsCommand, { rawArgs: [] })
  expect(lines.join('\n')).toContain('pages@example.com')
  expect(lines.join('\n')).not.toContain('d_example.com')
  lines.length = 0
  await runCommand(statsCommand, { rawArgs: ['--json'] })
  const output = JSON.parse(lines.join('\n'))
  expect(output.tables.find((table: { table: string }) => table.table === 'pages').watermarks[0].siteId).toBe('d_example.com')
})

it('exits non-zero in text mode when --site has no local data', async () => {
  mocks.store.engine.listAll.mockResolvedValue([entry('sc-domain:a.example')])
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code}__`)
  }) as never)
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  await expect(runCommand(statsCommand, { rawArgs: ['--site', 'sc-domain:typo.example'] })).rejects.toThrow('__exit_1__')
  expect(exit).toHaveBeenCalledWith(1)
  expect(lines.join('\n')).not.toContain('Empty Store.')
})

it('keeps the JSON recovery payload for a site without local data', async () => {
  mocks.store.engine.listAll.mockResolvedValue([entry('sc-domain:a.example')])
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  await runCommand(statsCommand, { rawArgs: ['--site', 'sc-domain:typo.example', '--json'] })
  const output = JSON.parse(lines.join('\n'))
  expect(output.knownSites).toEqual(['sc-domain:a.example'])
  expect(output.tables.every((table: { liveFiles: number }) => table.liveFiles === 0)).toBe(true)
})

it('resolves a known --site in text mode without exiting', async () => {
  mocks.store.engine.listAll.mockResolvedValue([entry('sc-domain:a.example')])
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code}__`)
  }) as never)
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  await runCommand(statsCommand, { rawArgs: ['--site', 'sc-domain:a.example'] })
  expect(exit).not.toHaveBeenCalled()
  expect(lines.join('\n')).toContain('pages')
})
