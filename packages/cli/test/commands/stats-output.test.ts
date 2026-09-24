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
vi.mock('../../src/context', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/context')>(),
  createCommandContext: vi.fn(async () => ({ store: mocks.store })),
}))

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

it('shows Site URLs, never Site IDs, in watermarks', async () => {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  await runCommand(statsCommand, { rawArgs: [] })
  expect(lines.join('\n')).toContain('pages@example.com')
  expect(lines.join('\n')).not.toContain('d_example.com')
  lines.length = 0
  await runCommand(statsCommand, { rawArgs: ['--json'] })
  const output = JSON.parse(lines.join('\n'))
  expect(output.tables.find((table: { table: string }) => table.table === 'pages').watermarks[0].siteUrl).toBe('sc-domain:example.com')
  expect(lines.join('\n')).not.toContain('d_example.com')
})
