import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { checkInspectionBatch, inspectUrls } from '../../src/inspect-urls'
import { loadInspectionHistory } from '../../src/local-entities'
import { createLocalStore } from '../../src/local-store'

const inspectMock = vi.fn()

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      inspect: inspectMock,
      sites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
    })),
  }
})

vi.mock('../../src/auth', () => ({
  resolveAuth: vi.fn().mockResolvedValue('mock-token'),
  resolveBYOK: vi.fn(() => null),
}))

function googleError(status: number, message: string): Error {
  return Object.assign(new Error(`[POST] "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect": ${status}`), {
    statusCode: status,
    data: { error: { code: status, message } },
  })
}

const PASS = { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } }

describe('inspectUrls', () => {
  const base = { inProperty: () => true, intervalMs: 0, sleep: async () => {} }

  it('keeps going after a URL fails and names the inspection rule', async () => {
    const inspect = vi.fn(async (url: string) => {
      if (url.endsWith('/b'))
        throw googleError(403, 'You do not own this site, or the inspected URL is not part of this property.')
      return PASS.inspectionResult
    })
    const run = await inspectUrls({ ...base, urls: ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'], inspect, onOutcome: async () => {} })
    expect(run.stopped).toBeNull()
    expect(run.outcomes.map(outcome => outcome.kind)).toEqual(['inspected', 'failed', 'inspected'])
    expect(run.outcomes[1]).toMatchObject({ kind: 'failed', error: expect.stringContaining('outside this property') })
  })

  it('stops at a quota error and counts the URLs left', async () => {
    const inspect = vi.fn(async (url: string) => {
      if (url.endsWith('/b'))
        throw googleError(429, 'Quota exceeded for quota metric.')
      return PASS.inspectionResult
    })
    const saved: string[] = []
    const run = await inspectUrls({
      ...base,
      urls: ['https://x.com/a', 'https://x.com/b', 'https://x.com/c', 'https://x.com/d'],
      inspect,
      onOutcome: async (outcome) => {
        saved.push(outcome.url)
      },
    })
    expect(saved).toEqual(['https://x.com/a'])
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(run.stopped).toEqual({ reason: expect.stringContaining('2,000 inspections per day'), remaining: 3 })
  })

  it('fails a URL outside the Site without an API call', async () => {
    const inspect = vi.fn()
    const run = await inspectUrls({ ...base, urls: ['https://other.com/'], inProperty: () => false, inspect, onOutcome: async () => {} })
    expect(inspect).not.toHaveBeenCalled()
    expect(run.outcomes).toEqual([{ kind: 'failed', url: 'https://other.com/', error: 'The URL is outside this Site.' }])
  })

  it('spaces call starts under 600 per minute', async () => {
    let clock = 0
    const waits: number[] = []
    await inspectUrls({
      urls: ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'],
      inProperty: () => true,
      inspect: async () => {
        clock += 20
        return PASS.inspectionResult
      },
      onOutcome: async () => {},
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
        clock += ms
      },
    })
    expect(waits).toEqual([100, 100])
    expect(60_000 / (20 + waits[0]!)).toBeLessThanOrEqual(600)
  })

  it('refuses more URLs than one day of quota', () => {
    const urls = Array.from({ length: 2001 }, (_, i) => `https://x.com/${i}`)
    expect(checkInspectionBatch(urls)).toMatchObject({ kind: 'too-many', message: expect.stringContaining('2,000') })
    expect(checkInspectionBatch(urls.slice(0, 2000))).toEqual({ kind: 'ok' })
  })
})

describe('gscdump inspect', () => {
  let configDir: string
  let dataDir: string
  const output: string[] = []
  const errors: string[] = []

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-inspect-test-'))
    dataDir = path.join(configDir, 'store')
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir }))
    output.length = 0
    errors.length = 0
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')))
    inspectMock.mockReset()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(configDir, { recursive: true, force: true })
  })

  const cli = (...args: string[]) => runCli({ rawArgs: ['--config-dir', configDir, 'inspect', ...args], loadEnv: false, environment: {} })

  async function storedUrls(): Promise<string[]> {
    const store = createLocalStore({ dataDir })
    const history = await loadInspectionHistory(store.dataSource, { userId: store.userId, siteId: store.siteIdFor('https://example.com/') })
    return history.map(record => record.url).sort()
  }

  it('inspects every positional URL and saves each result to the Store', async () => {
    inspectMock.mockResolvedValue(PASS)
    const code = await cli('https://example.com/a', 'https://example.com/b', '--site', 'https://example.com/', '--json')
    expect(code).toBe(0)
    expect(inspectMock.mock.calls.map(call => call[1])).toEqual(['https://example.com/a', 'https://example.com/b'])
    const json = JSON.parse(output.join('\n'))
    expect(json).toMatchObject({ inspected: 2, failed: 0, remaining: 0 })
    expect(json.results[0]).toMatchObject({ url: 'https://example.com/a', status: 'inspected', verdict: 'PASS', isIndexed: true })
    expect(await storedUrls()).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('keeps finished results when a quota error stops the run', async () => {
    inspectMock
      .mockResolvedValueOnce(PASS)
      .mockRejectedValueOnce(googleError(429, 'Quota exceeded.'))
    const code = await cli('https://example.com/a', 'https://example.com/b', 'https://example.com/c', '--site', 'https://example.com/', '--json')
    expect(code).toBe(1)
    expect(JSON.parse(output.join('\n'))).toMatchObject({ inspected: 1, remaining: 2 })
    expect(errors.join('\n')).toContain('Inspected 1 of 3 URLs and saved the results to the Store. 2 remaining.')
    expect(await storedUrls()).toEqual(['https://example.com/a'])
  })

  it('reports a failed URL and exits 1 without dropping the others', async () => {
    inspectMock
      .mockRejectedValueOnce(googleError(403, 'Permission denied.'))
      .mockResolvedValueOnce(PASS)
    const code = await cli('https://example.com/a', 'https://example.com/b', '--site', 'https://example.com/', '--json')
    expect(code).toBe(1)
    const json = JSON.parse(output.join('\n'))
    expect(json.results.map((result: { status: string }) => result.status)).toEqual(['failed', 'inspected'])
    expect(await storedUrls()).toEqual(['https://example.com/b'])
  })

  it('does not present deprecated mobile usability data', async () => {
    inspectMock.mockResolvedValue({
      inspectionResult: {
        indexStatusResult: { verdict: 'PASS' },
        mobileUsabilityResult: { verdict: 'FAIL', issues: [{ issueType: 'LEGACY' }] },
      },
    })
    expect(await cli('https://example.com/x', '--site', 'https://example.com/')).toBe(0)
    expect(output.join('\n')).toContain('Verdict')
    expect(output.join('\n')).not.toContain('Mobile usability')
    expect(output.join('\n')).not.toContain('LEGACY')
  })
})
