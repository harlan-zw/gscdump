import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sitemapsCommand } from '../../src/commands/sitemaps'

const listMock = vi.fn()
const getMock = vi.fn()
const submitMock = vi.fn()
const deleteMock = vi.fn()

vi.mock('gscdump/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/api')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      sites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
      sitemaps: { list: listMock, get: getMock, submit: submitMock, delete: deleteMock },
    })),
    fetchSitemap: vi.fn(async (_c, _site, feedpath) => getMock(feedpath)),
  }
})

vi.mock('../../src/auth', () => ({
  resolveAuth: vi.fn().mockResolvedValue('mock-token'),
  getAuth: vi.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  resolveBYOK: vi.fn(() => null),
}))

vi.mock('../../src/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({ defaultSite: 'https://example.com/' }),
  loadResolvedConfig: vi.fn().mockResolvedValue({
    config: { defaultSite: 'https://example.com/' },
    dataDir: '/tmp/gscdump-test',
  }),
  resolveDataDir: vi.fn(() => '/tmp/gscdump-test'),
}))

vi.mock('../../src/error-handler', () => ({
  gscErrorHandler: vi.fn((e: unknown) => { throw e }),
}))

vi.mock('../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils')>()
  return {
    ...actual,
    showSplash: vi.fn(),
    VERSION: '1.0.0',
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      start: vi.fn(),
    },
  }
})

describe('sitemaps command', () => {
  let consoleOutput: string[] = []
  const originalLog = console.log

  beforeEach(() => {
    consoleOutput = []
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    vi.clearAllMocks()
  })

  afterEach(() => {
    console.log = originalLog
  })

  it('has list/get/submit/delete subcommands', () => {
    expect(sitemapsCommand.subCommands).toHaveProperty('list')
    expect(sitemapsCommand.subCommands).toHaveProperty('get')
    expect(sitemapsCommand.subCommands).toHaveProperty('submit')
    expect(sitemapsCommand.subCommands).toHaveProperty('delete')
  })

  it('list emits json when --json', async () => {
    listMock.mockResolvedValue([
      { path: 'https://example.com/sitemap.xml', type: 'sitemap', isPending: false, errors: 0, warnings: 0 },
    ])
    const list = sitemapsCommand.subCommands!.list as any
    await list.run({ args: { site: 'https://example.com/', json: true }, rawArgs: [], cmd: list })
    const json = JSON.parse(consoleOutput.find(l => l.startsWith('['))!)
    expect(json[0].path).toBe('https://example.com/sitemap.xml')
  })

  it('list resolves site via context when --site omitted', async () => {
    listMock.mockResolvedValue([])
    const list = sitemapsCommand.subCommands!.list as any
    await list.run({ args: { json: true }, rawArgs: [], cmd: list })
    expect(listMock).toHaveBeenCalledWith('https://example.com/')
  })

  it('submit calls API with resolved site + url', async () => {
    submitMock.mockResolvedValue(undefined)
    const submit = sitemapsCommand.subCommands!.submit as any
    await submit.run({
      args: { site: 'https://example.com/', url: 'https://example.com/sitemap.xml' },
      rawArgs: [],
      cmd: submit,
    })
    expect(submitMock).toHaveBeenCalledWith('https://example.com/', 'https://example.com/sitemap.xml')
  })

  it('delete calls API with resolved site + url', async () => {
    deleteMock.mockResolvedValue(undefined)
    const del = sitemapsCommand.subCommands!.delete as any
    await del.run({
      args: { site: 'https://example.com/', url: 'https://example.com/sitemap.xml' },
      rawArgs: [],
      cmd: del,
    })
    expect(deleteMock).toHaveBeenCalledWith('https://example.com/', 'https://example.com/sitemap.xml')
  })
})
