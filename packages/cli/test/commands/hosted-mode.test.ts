import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

// Hosted mode reads the hosted record only. Every request must go to gscdump.com.
describe('hosted mode commands', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let requests: { url: URL, body: unknown }[]

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-mode-'))
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir: path.join(configDir, 'data') }))
    stderr = ''
    runtime = createCliRuntime({
      configDir,
      environment: { GSCDUMP_API_KEY: 'gsd_user_private', GSCDUMP_CONFIG_DIR: configDir },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk
          return true
        },
      } as unknown as NodeJS.WriteStream,
    })
    stdout = []
    requests = []
    vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderr += `${args.join(' ')}\n`
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const url = new URL(request ? request.url : input as string | URL)
      const text = request ? await request.text() : typeof init?.body === 'string' ? init.body : ''
      requests.push({ url, body: text ? JSON.parse(text) : undefined })
      if (url.origin !== 'https://gscdump.com')
        throw new Error(`Hosted mode called ${url.origin}`)
      if (url.pathname === '/api/cli/me') {
        return Response.json({
          user: { publicId: 'u_me', email: 'user@example.com' },
          sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com', syncStatus: 'synced', oldestDateSynced: '2025-01-01', newestDateSynced: '2026-09-26' }],
        })
      }
      if (url.pathname === '/api/analytics/v1/sites/s_site/rows') {
        return Response.json({
          data: { rows: [{ query: 'gscdump', clicks: 12, impressions: 340, ctr: 0.035, position: 4.2 }] },
          meta: { requestId: 'req_rows', surface: 'analytics', version: '1.0', sourceName: 'iceberg', sourceKind: 'sql', queryMs: 3 },
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime, loadEnv: false })

  it('lists hosted Sites from the hosted record', async () => {
    await expect(run(['sites', '--json'])).resolves.toBe(0)
    expect(JSON.parse(stdout.join('\n'))).toEqual([expect.objectContaining({ siteId: 's_site', siteUrl: 'sc-domain:example.com', hostedSync: expect.objectContaining({ syncStatus: 'synced' }) })])
    expect(requests.map(request => request.url.pathname)).toEqual(['/api/cli/me'])
  })

  it('queries the hosted record through the public rows operation', async () => {
    await expect(run(['query', '--site', 'example.com', '-d', 'query', '--start', '2026-08-01', '--end', '2026-08-28', '--limit', '10', '--format', 'json'])).resolves.toBe(0)
    const output = JSON.parse(stdout.join('\n'))
    expect(output).toMatchObject({ siteUrl: 'sc-domain:example.com', total: 1, meta: { source: 'hosted' } })
    expect(output.data).toEqual([{ query: 'gscdump', clicks: 12, impressions: 340, ctr: 0.035, position: 4.2 }])
    const rows = requests.find(request => request.url.pathname.endsWith('/rows'))
    expect(rows?.body).toMatchObject({ dimensions: ['query'], rowLimit: 10, searchType: 'web' })
  })

  it.each([
    ['sync', ['sync', '--site', 'example.com']],
    ['inspect', ['inspect', 'https://example.com/', '--site', 'example.com']],
    ['query --live', ['query', '--site', 'example.com', '-d', 'query', '--live']],
    ['sites add', ['sites', 'add', 'https://example.com/']],
  ])('refuses %s with the Local mode setup command and never calls Google', async (_label, args) => {
    await expect(run(args)).resolves.not.toBe(0)
    expect(stderr).toMatch(/Local mode/)
    expect(stderr).toContain('gscdump auth login --mode local')
    expect(requests.every(request => request.url.origin === 'https://gscdump.com')).toBe(true)
  })
})
