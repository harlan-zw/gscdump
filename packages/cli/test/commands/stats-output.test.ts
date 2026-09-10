import { runCommand } from 'citty'
import { afterEach, expect, it, vi } from 'vitest'
import { statsCommand } from '../../src/commands/stats'

vi.mock('@gscdump/engine/filesystem', () => ({
  filesystemStats: vi.fn().mockResolvedValue({ files: 0, bytes: 0 }),
}))
vi.mock('../../src/context', () => ({
  createCommandContext: vi.fn().mockResolvedValue({
    store: {
      dataDir: '/fixture/data',
      userId: 'local',
      engine: {
        listAll: vi.fn().mockResolvedValue([]),
        getWatermarks: vi.fn().mockResolvedValue([{
          table: 'pages',
          siteId: 'd_example.com',
          oldestDateSynced: '2026-08-01',
          newestDateSynced: '2026-08-28',
          lastSyncAt: 0,
        }]),
      },
    },
  }),
}))

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
