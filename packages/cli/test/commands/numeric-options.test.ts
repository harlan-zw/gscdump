import type { CommandDef } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeCommand } from '../../src/commands/analyze'
import { entitiesCommand } from '../../src/commands/entities'
import { indexingCommand } from '../../src/commands/indexing'
import { sitemapsCommand } from '../../src/commands/sitemaps'
import { syncCommand } from '../../src/commands/sync'

const boundary = vi.hoisted(() => ({
  context: vi.fn(),
  analysis: vi.fn(),
  sitemap: vi.fn(),
  hosted: vi.fn(),
  indexingBatch: vi.fn(),
  inspectionBatch: vi.fn(),
}))

vi.mock('../../src/context', () => ({ createCommandContext: boundary.context }))
vi.mock('../../src/analysis-local', () => ({ resolveAnalysisSource: boundary.analysis }))
vi.mock('../../src/sitemap', () => ({ loadSitemapUrls: boundary.sitemap, discoverLiveSitemap: vi.fn() }))
vi.mock('@gscdump/sdk/v1', () => ({ createGscdumpV1Client: boundary.hosted }))
vi.mock('gscdump/indexing', async importOriginal => ({
  ...await importOriginal<typeof import('gscdump/indexing')>(),
  batchRequestIndexing: boundary.indexingBatch,
  batchInspectUrls: boundary.inspectionBatch,
}))

function child(command: CommandDef<any>, ...path: string[]): CommandDef<any> {
  let current = command
  for (const name of path)
    current = (current.subCommands as Record<string, CommandDef<any>>)[name]!
  return current
}

async function run(command: CommandDef<any>, args: Record<string, unknown>): Promise<void> {
  await command.run!({ args: { json: true, ...args }, rawArgs: [], cmd: command } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  boundary.context.mockRejectedValue(new Error('Context started'))
  boundary.analysis.mockRejectedValue(new Error('Analysis started'))
  boundary.sitemap.mockRejectedValue(new Error('Sitemap fetch started'))
  boundary.hosted.mockImplementation(() => {
    throw new Error('Hosted client started')
  })
  boundary.indexingBatch.mockResolvedValue([])
  boundary.inspectionBatch.mockResolvedValue([])
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const urlArgs = { _: ['https://example.com/'], type: 'URL_UPDATED' }
const sitemapArgs = { 'url': 'https://example.com/sitemap.xml', 'site': 'example.com', 'api-key': 'token' }

const cases = [
  ['indexing submit', child(indexingCommand, 'submit'), { url: 'https://example.com/' }, 'retries', '1.5'],
  ['indexing remove', child(indexingCommand, 'remove'), { url: 'https://example.com/' }, 'retries', '-1'],
  ['indexing batch', child(indexingCommand, 'batch'), urlArgs, 'retries', '3oops'],
  ['indexing batch', child(indexingCommand, 'batch'), urlArgs, 'delay-ms', '-1'],
  ['indexing batch', child(indexingCommand, 'batch'), urlArgs, 'concurrency', '0'],
  ['indexing batch-status', child(indexingCommand, 'batch-status'), urlArgs, 'retries', ''],
  ['indexing batch-status', child(indexingCommand, 'batch-status'), urlArgs, 'delay-ms', '100ms'],
  ['indexing batch-status', child(indexingCommand, 'batch-status'), urlArgs, 'concurrency', 'NaN'],
  ['entities indexing snapshot', child(entitiesCommand, 'indexing', 'snapshot'), {}, 'concurrency', 'Infinity'],
  ['indexing urls', child(indexingCommand, 'urls'), { site: 'example.com', format: 'table' }, 'limit', '0'],
  ['indexing urls', child(indexingCommand, 'urls'), { site: 'example.com', format: 'table' }, 'limit', '501'],
  ['indexing urls', child(indexingCommand, 'urls'), { site: 'example.com', format: 'table' }, 'offset', '-1'],
  ['sync', syncCommand, {}, 'days', '3days'],
  ['sync', syncCommand, {}, 'concurrency', '2.7'],
  ['sitemaps urls', child(sitemapsCommand, 'urls'), sitemapArgs, 'limit', '0'],
  ['sitemaps urls', child(sitemapsCommand, 'urls'), sitemapArgs, 'max-depth', '-1'],
  ['sitemaps history', child(sitemapsCommand, 'history'), sitemapArgs, 'days', '7days'],
  ['sitemaps lastmod', child(sitemapsCommand, 'lastmod'), sitemapArgs, 'limit', '9007199254740992'],
  ['analyze trends', child(analyzeCommand, 'trends'), {}, 'limit', '2.5'],
  ['analyze trends', child(analyzeCommand, 'trends'), {}, 'weeks', '0'],
  ['analyze trends', child(analyzeCommand, 'trends'), {}, 'min-weeks', 'NaN'],
] as const

describe('cLI numeric options', () => {
  it.each(cases.map(([name, command, args, flag, value]) => ({ name, command, args, flag, value })))('$name rejects --$flag before external work', async ({ command, args, flag, value }) => {
    await expect(run(command, { ...args, [flag]: value })).rejects.toThrow(`--${flag}`)
    expect(boundary.context).not.toHaveBeenCalled()
    expect(boundary.analysis).not.toHaveBeenCalled()
    expect(boundary.sitemap).not.toHaveBeenCalled()
    expect(boundary.hosted).not.toHaveBeenCalled()
  })

  it('keeps zero retries and delay, and forwards positive concurrency', async () => {
    const client = {}
    boundary.context.mockResolvedValueOnce({ client })
    await run(child(indexingCommand, 'batch'), { ...urlArgs, 'retries': '0', 'delay-ms': '0', 'concurrency': '2' })
    expect(boundary.context).toHaveBeenCalledWith({ needsAuth: true, fetchOptions: { retry: 0 } })
    expect(boundary.indexingBatch).toHaveBeenCalledWith(client, urlArgs._, expect.objectContaining({ delayMs: 0, concurrency: 2 }))
  })

  it('retains the indexing batch defaults when options are absent', async () => {
    const client = {}
    boundary.context.mockResolvedValueOnce({ client })
    await run(child(indexingCommand, 'batch'), urlArgs)
    expect(boundary.context).toHaveBeenCalledWith({ needsAuth: true, fetchOptions: { retry: undefined } })
    expect(boundary.indexingBatch).toHaveBeenCalledWith(client, urlArgs._, expect.objectContaining({ delayMs: 100, concurrency: 1 }))
  })

  it('accepts a zero sitemap depth', async () => {
    boundary.sitemap.mockResolvedValueOnce({ _tag: 'ok', value: { urls: [], complete: true, documentsRead: 1 } })
    await run(child(sitemapsCommand, 'urls'), { ...sitemapArgs, 'max-depth': '0' })
    expect(boundary.sitemap).toHaveBeenCalledWith(sitemapArgs.url, expect.objectContaining({ maxDepth: 0 }))
  })

  it('cuts sitemap URLs to --limit after reading whole documents', async () => {
    const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']
    boundary.sitemap.mockResolvedValueOnce({ _tag: 'ok', value: { urls, complete: true, documentsRead: 1 } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(child(sitemapsCommand, 'urls'), { ...sitemapArgs, limit: '2' })
    const [options] = boundary.sitemap.mock.calls[0]!.slice(1) as [{ maxUrls: number }]
    expect(options.maxUrls).toBeGreaterThan(2)
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ count: 2, found: 3, urls: urls.slice(0, 2) })
  })

  it('forwards positive Analyzer limits and week counts', async () => {
    const runAnalysis = vi.fn().mockResolvedValue({ results: [], meta: {} })
    boundary.analysis.mockResolvedValueOnce({ format: 'json', runAnalysis })
    await run(child(analyzeCommand, 'trends'), { 'limit': '5', 'weeks': '8', 'min-weeks': '2' })
    expect(runAnalysis).toHaveBeenCalledWith(expect.objectContaining({ limit: 5, weeks: 8, minWeeksWithData: 2 }))
  })
})
