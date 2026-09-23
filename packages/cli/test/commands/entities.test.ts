import type { CommandDef } from 'citty'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entitiesCommand } from '../../src/commands/entities'
import { inspectCommand } from '../../src/commands/inspect'
import { readSiteMap, recordStoreSite } from '../../src/store-sites'

const configState: { dataDir: string | null } = { dataDir: null }

const SITE = 'https://example.com/'

const inspectSpy = vi.fn()
const metadataSpy = vi.fn()
const clientSitesSpy = vi.fn()

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      sites: clientSitesSpy,
      inspect: inspectSpy,
      indexing: { getMetadata: metadataSpy },
    })),
  }
})

vi.mock('../../src/auth', () => ({
  getAuth: vi.fn(() => Promise.resolve({})),
  resolveAuth: vi.fn(() => Promise.resolve({})),
  resolveBYOK: vi.fn(() => null),
}))

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>()
  const config = () => ({ dataDir: configState.dataDir ?? undefined })
  return {
    ...actual,
    loadConfig: vi.fn(() => Promise.resolve(config())),
    loadResolvedConfig: vi.fn(() => Promise.resolve({
      config: config(),
      dataDir: actual.resolveDataDir(config()),
    })),
  }
})

vi.mock('../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils')>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      start: vi.fn(),
    },
    progressBar: vi.fn(() => ''),
  }
})

function child(command: CommandDef<any>, ...path: string[]): CommandDef<any> {
  let current = command
  for (const name of path)
    current = (current.subCommands as Record<string, CommandDef<any>>)[name]!
  return current
}

async function run(command: CommandDef<any>, args: Record<string, unknown>): Promise<void> {
  await command.run!({ args, rawArgs: [], cmd: command } as never)
}

let tmpDir: string | null = null

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-entities-'))
  configState.dataDir = tmpDir
  inspectSpy.mockReset().mockResolvedValue({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } })
  metadataSpy.mockReset().mockResolvedValue({ latestUpdate: { notifyTime: '2026-09-01T00:00:00Z' } })
  clientSitesSpy.mockReset().mockResolvedValue([{ siteUrl: SITE, permissionLevel: 'siteOwner' }])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir!, { recursive: true, force: true })
  tmpDir = null
  configState.dataDir = null
})

afterAll(() => {
  resetNodeDuckDB()
})

async function writeUrlList(urls: string[]): Promise<string> {
  const file = path.join(tmpDir!, 'urls.txt')
  await fs.writeFile(file, `${urls.join('\n')}\n`)
  return file
}

describe('inspect', () => {
  it('records the Site in the Store map before writing inspections', async () => {
    const file = await writeUrlList(['https://example.com/page'])
    await run(inspectCommand, { _: [], site: SITE, file, quiet: true })
    expect(await readSiteMap(tmpDir!)).toEqual({ 'h_example.com': SITE })
  })

  it('fails before any inspection when the Store ID holds another Site', async () => {
    // A Store that already serves http://example.com/ under the shared ID.
    await fs.mkdir(path.join(tmpDir!, 'u_local', 'h_example.com'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir!, 'u_local', 'sites.json'),
      `${JSON.stringify({ version: 1, sites: { 'h_example.com': 'http://example.com/' } }, null, 2)}\n`,
    )
    const file = await writeUrlList(['https://example.com/page'])
    await expect(run(inspectCommand, { _: [], site: SITE, file, quiet: true }))
      .rejects
      .toThrow('The Store keeps http://example.com/ under the same ID as https://example.com/')
    expect(inspectSpy).not.toHaveBeenCalled()
    // Nothing was written under the claimed ID.
    expect(await recordStoreSite(tmpDir!, 'http://example.com/')).toEqual({ ok: true, value: undefined })
  })
})

describe('entities indexing snapshot', () => {
  it('records the Site in the Store map before writing metadata', async () => {
    const file = await writeUrlList(['https://example.com/page'])
    await run(child(entitiesCommand, 'indexing', 'snapshot'), { site: SITE, file, quiet: true })
    expect(await readSiteMap(tmpDir!)).toEqual({ 'h_example.com': SITE })
  })
})
