import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { getPstDate } from 'gscdump/dates'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'

// The shared setup file mocks ofetch; this test drives the real client over a stubbed fetch.
vi.mock('ofetch', async () => await vi.importActual('ofetch'))

const SITE = 'sc-domain:example.com'

describe('inspect quota', () => {
  let root: string
  let dataDir: string
  let inspections: number
  let stderr: string[]

  beforeEach(async () => {
    resetNodeDuckDB()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-inspect-quota-'))
    dataDir = path.join(root, 'data')
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ dataDir }))
    inspections = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/webmasters/v3/sites'))
        return Response.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })
      if (url.endsWith('/v1/urlInspection/index:inspect')) {
        inspections++
        return Response.json({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stderr = []
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      stderr.push(values.map(String).join(' '))
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetNodeDuckDB()
    await fs.rm(root, { recursive: true, force: true })
  })

  const inspect = (): Promise<number> => runCli({
    rawArgs: ['inspect', 'https://example.com/a', 'https://example.com/b', '--site', 'example.com', '--json'],
    environment: { GSCDUMP_CONFIG_DIR: root, GSC_ACCESS_TOKEN: 'token', GSCDUMP_AUTH_MODE: 'local' },
    loadEnv: false,
  })

  it('counts each inspection in the shared quota ledger', async () => {
    expect(await inspect()).toBe(0)
    expect(inspections).toBe(2)
    const ledger = JSON.parse(await fs.readFile(path.join(dataDir, 'quota-ledger.json'), 'utf8'))
    expect(ledger.usage).toEqual([{ api: 'urlInspection', site: SITE, day: getPstDate(new Date()), used: 2 }])
  })

  it('stops before calling Google when the daily inspection quota is spent', async () => {
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'quota-ledger.json'), JSON.stringify({
      version: 1,
      usage: [{ api: 'urlInspection', site: SITE, day: getPstDate(new Date()), used: 2000 }],
    }))
    expect(await inspect()).toBe(1)
    expect(inspections).toBe(0)
    expect(stderr.join('\n')).toContain('2 remaining. The Google URL Inspection quota for sc-domain:example.com is used up (2000 calls a day). It resets at')
  })
})
