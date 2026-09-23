import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createNodeHarness, resetNodeDuckDB } from '@gscdump/engine/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'
import { listStoreSites, readSiteMap, recordStoreSite } from '../src/store-sites'

let root: string
let configDir: string
let dataDir: string
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

async function seed(siteUrl: string, clicks = 5): Promise<void> {
  const store = createNodeHarness({ dataDir })
  await store.engine.writeDay(
    { userId: 'local', siteId: store.siteIdFor(siteUrl), table: 'pages', date: '2026-08-01' },
    [{ url: '/guide', date: '2026-08-01', clicks, impressions: 50, sum_position: 150 }],
  )
  await store.engine.setSyncState({ userId: 'local', siteId: store.siteIdFor(siteUrl), table: 'pages', date: '2026-08-01', searchType: 'web' }, 'done')
  const recorded = await recordStoreSite(dataDir, siteUrl)
  expect(recorded.ok).toBe(true)
}

interface CliRun { code: number, stdout: string, stderr: string }

async function cli(...rawArgs: string[]): Promise<CliRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => stdout.push(values.map(String).join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => stderr.push(values.map(String).join(' ')))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw Object.assign(new Error('exit'), { exitCode: code ?? 0 })
  }) as never)
  const code = await runCli({ rawArgs, environment: { GSCDUMP_CONFIG_DIR: configDir }, loadEnv: false })
    .then(() => 0)
    .catch((error: { exitCode?: number }) => {
      if (error.exitCode === undefined)
        throw error
      return error.exitCode
    })
  vi.restoreAllMocks()
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value })
}

beforeEach(async () => {
  resetNodeDuckDB()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-site-resolution-'))
  configDir = path.join(root, 'config')
  dataDir = path.join(root, 'data')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
    if (descriptor)
      Object.defineProperty(stream, 'isTTY', descriptor)
    else
      Reflect.deleteProperty(stream, 'isTTY')
  }
  resetNodeDuckDB()
  await fs.rm(root, { recursive: true, force: true })
})

describe('--site resolution without login', () => {
  it.each(['example.com', 'https://example.com', 'https://example.com/', 'www.example.com', 'Example.COM'])('store stats --site %s finds the domain property', async (input) => {
    await seed('sc-domain:example.com')
    const run = await cli('store', 'stats', '--site', input, '--json')
    expect(run.code).toBe(0)
    const output = JSON.parse(run.stdout)
    expect(output.siteUrl).toBe('sc-domain:example.com')
    expect(output.tables.find((table: { table: string }) => table.table === 'pages').liveRows).toBe(1)
  })

  it('store stats --site exits 1 for a Site with no local data', async () => {
    await seed('sc-domain:example.com')
    const run = await cli('store', 'stats', '--site', 'nuxt.com', '--json')
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('The Store has no data for "nuxt.com". Local Sites: sc-domain:example.com')
  })

  it('never picks a longer Site that contains the input', async () => {
    await seed('https://scripts.nuxt.com/')
    const run = await cli('store', 'stats', '--site', 'nuxt.com', '--json')
    expect(run.code).toBe(1)
  })

  it('sync --status --site https://example.com shows the Site watermarks', async () => {
    await seed('sc-domain:example.com')
    await seed('sc-domain:other.com')
    const run = await cli('sync', '--status', '--site', 'https://example.com', '--json')
    expect(run.code).toBe(0)
    const output = JSON.parse(run.stdout)
    expect(output.siteFilter).toBe('sc-domain:example.com')
    expect(output.watermarks).toEqual([expect.objectContaining({ table: 'pages', siteUrl: 'sc-domain:example.com', newestDateSynced: '2026-08-01' })])
  })

  it('query --site example.com reads the Store', async () => {
    await seed('sc-domain:example.com', 7)
    const run = await cli('query', '--site', 'example.com', '--dimensions', 'page', '--start', '2026-08-01', '--end', '2026-08-01', '--format', 'json')
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ siteUrl: 'sc-domain:example.com', data: [{ page: '/guide', clicks: 7 }] })
  })

  it('reads the real Site URL of a URL-prefix property with a path', async () => {
    await seed('https://example.com/blog/')
    const run = await cli('store', 'stats', '--site', 'example.com/blog', '--json')
    expect(JSON.parse(run.stdout).siteUrl).toBe('https://example.com/blog/')
  })
})

describe('site picker', () => {
  it('exits 1 without a terminal and lists the Sites', async () => {
    await seed('sc-domain:example.com')
    await seed('sc-domain:other.com')
    setTTY(false)
    const run = await cli('analyze', 'striking-distance', '--json')
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('Pass --site. Sites: sc-domain:example.com, sc-domain:other.com')
  })

  it('picks the only local Site when no auth is present', async () => {
    await seed('sc-domain:example.com')
    setTTY(false)
    const run = await cli('analyze', 'striking-distance', '--json')
    expect(run.stderr).not.toContain('Pass --site')
    expect(run.code).toBe(0)
  })
})

describe('site map', () => {
  it('refuses a Site whose ID holds data for a different Site', async () => {
    await seed('https://example.com/')
    const collision = await recordStoreSite(dataDir, 'http://example.com/')
    expect(collision).toEqual({
      ok: false,
      error: { kind: 'site-id-collision', siteId: 'h_example.com', siteUrl: 'http://example.com/', existing: 'https://example.com/' },
    })
  })

  it('lets a Site claim an ID after the old data is removed', async () => {
    await seed('https://example.com/')
    const run = await cli('store', 'rm-site', 'example.com', '--yes', '--json')
    expect(run.code).toBe(0)
    expect(await recordStoreSite(dataDir, 'http://example.com/')).toEqual({ ok: true, value: undefined })
    expect(await listStoreSites(dataDir)).toEqual([])
  })

  it('refuses a claim against a pre-map Store holding another Site\'s data', async () => {
    // Stores created before the map have no sites.json entry, so the decoded
    // ID is the only owner label. An http twin must not relabel its data.
    await fs.mkdir(path.join(dataDir, 'u_local', 'h_example.com'), { recursive: true })
    const collision = await recordStoreSite(dataDir, 'http://example.com/')
    expect(collision).toEqual({
      ok: false,
      error: { kind: 'site-id-collision', siteId: 'h_example.com', siteUrl: 'http://example.com/', existing: 'https://example.com/' },
    })
  })

  it('adopts a pre-map Store for its decoded Site URL', async () => {
    await fs.mkdir(path.join(dataDir, 'u_local', 'h_example.com'), { recursive: true })
    expect(await recordStoreSite(dataDir, 'https://example.com/')).toEqual({ ok: true, value: undefined })
    expect(await readSiteMap(dataDir)).toEqual({ 'h_example.com': 'https://example.com/' })
  })

  it('keeps every entry when many Sites claim at once', async () => {
    const sites = Array.from({ length: 24 }, (_, index) => `https://site-${index}.example.com/`)
    const claims = await Promise.all(sites.map(siteUrl => recordStoreSite(dataDir, siteUrl)))
    expect(claims.every(claim => claim.ok)).toBe(true)
    expect(Object.values(await readSiteMap(dataDir)).sort()).toEqual([...sites].sort())
  })

  it('lets one of two colliding Sites win a concurrent claim', async () => {
    // Data exists under the shared ID, but no Site owns it yet.
    await fs.mkdir(path.join(dataDir, 'u_local', 'h_example.com'), { recursive: true })
    const claims = await Promise.all(['https://example.com/', 'http://example.com/'].map(siteUrl => recordStoreSite(dataDir, siteUrl)))
    const winners = claims.filter(claim => claim.ok)
    expect(winners).toHaveLength(1)
    const map = await readSiteMap(dataDir)
    expect(claims.find(claim => !claim.ok)).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'site-id-collision', existing: map['h_example.com'] }),
    })
  })

  it('keeps every entry when separate processes claim at once', async () => {
    const module = fileURLToPath(new URL('../src/store-sites.ts', import.meta.url))
    const sites = Array.from({ length: 6 }, (_, index) => `https://proc-${index}.example.com/`)
    const script = `const { recordStoreSite } = await import(${JSON.stringify(module)}); `
      + `const claim = await recordStoreSite(process.argv[1], process.argv[2]); if (!claim.ok) process.exit(2)`
    await Promise.all(sites.map(siteUrl => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir, siteUrl])))
    expect(Object.values(await readSiteMap(dataDir)).sort()).toEqual([...sites].sort())
  })

  it('falls back to the decoded ID for a Store without a map', async () => {
    const store = createNodeHarness({ dataDir })
    await store.engine.writeDay(
      { userId: 'local', siteId: store.siteIdFor('sc-domain:example.com'), table: 'pages', date: '2026-08-01' },
      [{ url: '/guide', date: '2026-08-01', clicks: 1, impressions: 5, sum_position: 5 }],
    )
    expect(await listStoreSites(dataDir)).toEqual([{ siteId: 'd_example.com', siteUrl: 'sc-domain:example.com' }])
  })
})
