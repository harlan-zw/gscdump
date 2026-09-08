import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { indexingCommand } from '../../src/commands/indexing'
import { setConfigDir } from '../../src/config'

let configDir: string
beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-command-test-'))
  setConfigDir(configDir)
})
afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true })
})

const publishMock = vi.fn()
const getMetadataMock = vi.fn()

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      indexing: { publish: publishMock, getMetadata: getMetadataMock },
    })),
  }
})

vi.mock('gscdump/indexing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/indexing')>()
  return {
    ...actual,
    requestIndexing: vi.fn(async (_c, url, opts) => {
      const r = await publishMock(url, opts?.type ?? 'URL_UPDATED')
      return { url, type: opts?.type ?? 'URL_UPDATED', notifyTime: r?.urlNotificationMetadata?.latestUpdate?.notifyTime }
    }),
    getIndexingMetadata: vi.fn(async (_c, url) => {
      const r = await getMetadataMock(url)
      return { url, latestUpdate: r?.latestUpdate, latestRemove: r?.latestRemove }
    }),
    batchRequestIndexing: vi.fn(async (_c, urls, opts) => {
      const out = []
      for (const url of urls) {
        const r = await publishMock(url, opts?.type ?? 'URL_UPDATED')
        out.push({ url, type: opts?.type ?? 'URL_UPDATED', notifyTime: r?.urlNotificationMetadata?.latestUpdate?.notifyTime })
      }
      return out
    }),
  }
})

vi.mock('../../src/auth', () => ({
  resolveAuth: vi.fn().mockResolvedValue('mock-token'),
  getAuth: vi.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  resolveBYOK: vi.fn(() => null),
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

describe('indexing command', () => {
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

  it('has correct metadata and subcommands', () => {
    expect(indexingCommand.meta?.name).toBe('indexing')
    expect(indexingCommand.subCommands).toHaveProperty('submit')
    expect(indexingCommand.subCommands).toHaveProperty('remove')
    expect(indexingCommand.subCommands).toHaveProperty('status')
    expect(indexingCommand.subCommands).toHaveProperty('batch')
  })

  it('submit emits json when --json', async () => {
    publishMock.mockResolvedValue({ urlNotificationMetadata: { latestUpdate: { notifyTime: '2026-01-01T00:00:00Z' } } })
    const submit = indexingCommand.subCommands!.submit as any
    await submit.run({ args: { url: 'https://example.com/x', json: true }, rawArgs: [], cmd: submit })
    const json = JSON.parse(consoleOutput[0])
    expect(json).toEqual({ url: 'https://example.com/x', type: 'URL_UPDATED', notifyTime: '2026-01-01T00:00:00Z' })
  })

  it('remove uses URL_DELETED', async () => {
    publishMock.mockResolvedValue({ urlNotificationMetadata: { latestUpdate: { notifyTime: 't' } } })
    const remove = indexingCommand.subCommands!.remove as any
    await remove.run({ args: { url: 'https://example.com/x', json: true }, rawArgs: [], cmd: remove })
    expect(publishMock).toHaveBeenCalledWith('https://example.com/x', 'URL_DELETED')
  })

  it('status returns metadata', async () => {
    getMetadataMock.mockResolvedValue({ latestUpdate: { notifyTime: 'u' }, latestRemove: { notifyTime: 'r' } })
    const status = indexingCommand.subCommands!.status as any
    await status.run({ args: { url: 'https://example.com/x', json: true }, rawArgs: [], cmd: status })
    const json = JSON.parse(consoleOutput[0])
    expect(json.url).toBe('https://example.com/x')
    expect(json.latestUpdate.notifyTime).toBe('u')
  })

  it('batch invokes publish for each URL', async () => {
    publishMock.mockResolvedValue({ urlNotificationMetadata: { latestUpdate: { notifyTime: 't' } } })
    const batch = indexingCommand.subCommands!.batch as any
    await batch.run({
      args: { 'urls': ['https://a.com', 'https://b.com'], 'delay-ms': '0', 'type': 'URL_UPDATED', 'json': true },
      rawArgs: [],
      cmd: batch,
    })
    expect(publishMock).toHaveBeenCalledTimes(2)
  })
})
