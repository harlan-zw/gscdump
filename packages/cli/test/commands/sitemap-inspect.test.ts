import process from 'node:process'
import { afterEach, expect, it, vi } from 'vitest'
import { sitemapsCommand } from '../../src/commands/sitemaps'

const inspect = vi.hoisted(() => vi.fn())
vi.mock('../../src/hosted-site', () => ({
  HOSTED_ARGS: {},
  resolveHostedSite: async () => ({ client: { inspectSiteSitemap: inspect }, site: { siteId: 's_01', siteUrl: 'https://example.com/' } }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = 0
})

it('prints exact provider evidence as JSON through the hosted operation', async () => {
  const data = {
    searchEngine: 'bing',
    sitemapUrl: 'https://example.com/Old.xml?part=1',
    capture: { _tag: 'captured', source: 'stored', capturedAt: '2026-10-07T02:00:00.000Z' },
    state: { _tag: 'missing' },
  }
  inspect.mockResolvedValue({ data })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const command = sitemapsCommand.subCommands!.inspect as any
  await command.run({ args: { site: 'example.com', engine: 'bing', url: data.sitemapUrl, json: true }, rawArgs: [], cmd: command })
  expect(inspect).toHaveBeenCalledWith({ params: { siteId: 's_01' }, query: { searchEngine: 'bing', url: data.sitemapUrl } })
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(data)
})

it('preserves the unavailable value and exits nonzero', async () => {
  const data = {
    searchEngine: 'google',
    sitemapUrl: 'https://example.com/sitemap.xml',
    capture: { _tag: 'unavailable' },
    state: { _tag: 'unavailable', reason: 'provider-unavailable', retryable: true },
  }
  inspect.mockResolvedValue({ data })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const command = sitemapsCommand.subCommands!.inspect as any
  await command.run({ args: { engine: 'google', url: data.sitemapUrl, json: true }, rawArgs: [], cmd: command })
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(data)
  expect(process.exitCode).toBe(1)
})
