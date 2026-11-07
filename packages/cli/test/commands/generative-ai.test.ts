import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generativeAiCommand } from '../../src/commands/generative-ai'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'
import { stopDetailsOf } from '../../src/stop'

// Synthetic export in the verified shape: five CSV files, no trailing newline.
const EXPORT_FILES = {
  'Chart.csv': 'Date,Impressions\n2026-03-01,0\n2026-03-02,4\n2026-03-03,7',
  'Pages.csv': 'Top pages,Impressions\nhttps://example.com/guides/alpha,8\nhttp://example.com/guides/alpha,2\nhttps://other.test/,5',
  'Countries.csv': 'Country,Impressions\nUnited States,6\nTurkey,5',
  'Devices.csv': 'Device,Impressions\nDesktop,9\nMobile,2',
  'Filters.csv': 'Filter,Value\nSearch type,Web (text-based)\nDate,Last 3 months',
}
const EXPORT_NAME = 'example.com-Performance-on-Search-Generative-AI-Features-2026-03-05.zip'
const meta = { requestId: 'req_gai', surface: 'partner', version: '1.0' }
const window = { startDate: '2026-03-01', endDate: '2026-03-03', label: 'Last 3 months' }
const receipt = { uploadId: 'gau_01', deduped: false, warnings: [], unmappedCountries: [], window, rowCounts: { chart: 3, pages: 2, countries: 2, devices: 2 } }
const envelope = (data: unknown) => Response.json({ data, meta })
const apiError = (status: number, code: string, message: string) => Response.json({ error: { code, message, requestId: 'req_gai', retryable: false, details: {} } }, { status })

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])))
}

type Route = (url: URL, init: RequestInit) => Response

describe('gscdump generative-ai', () => {
  let runtime: CliRuntime
  let output: string[]
  let requests: { url: URL, method: string, body: unknown }[]
  let route: Route

  beforeEach(async () => {
    runtime = createCliRuntime({
      configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-generative-ai-')),
      environment: { GSCDUMP_API_KEY: 'gsd_user_private' },
    })
    output = []
    requests = []
    route = () => {
      throw new Error('No route')
    }
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(input)
      if (url.pathname.endsWith('/cli/me'))
        return Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com' }] })
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null })
      return route(url, init)
    }))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  function run(args: string[]) {
    runtime.rawArgs = ['generative-ai', ...args]
    return runWithCliRuntime(runtime, () => runCommand(generativeAiCommand, { rawArgs: args }))
  }
  async function writeExport(files: Record<string, string> = EXPORT_FILES, name = EXPORT_NAME): Promise<string> {
    const file = path.join(runtime.configDir, name)
    await fs.writeFile(file, zipOf(files))
    return file
  }
  async function stopOf(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (thrown: unknown) => thrown)
    return stopDetailsOf(error)
  }

  it('parses the export locally and uploads normalized rows for the selected Site', async () => {
    route = () => envelope(receipt)
    await run(['upload', await writeExport(), '--site', 'example.com', '--json'])

    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.url.pathname).toBe('/api/partner/v1/sites/s_site/generative-ai/uploads')
    const body = requests[0]!.body as { sourceFilename: string, chart: { rows: unknown[] }, pages: { offHostRows: number, rows: { url: string }[] } }
    expect(body.sourceFilename).toBe(EXPORT_NAME)
    expect(body.chart.rows).toHaveLength(3)
    expect(body.pages.rows.map(row => row.url)).toEqual(['https://example.com/guides/alpha', 'http://example.com/guides/alpha'])
    expect(body.pages.offHostRows).toBe(1)
    expect(JSON.parse(output.at(-1)!)).toEqual(receipt)
  })

  it('refuses a classic Search results export by name before any request', async () => {
    const file = await writeExport({ ...EXPORT_FILES, 'Pages.csv': 'Top pages,Clicks,Impressions,CTR,Position\nhttps://example.com/,1,2,50%,3' })
    const stop = await stopOf(run(['upload', file, '--site', 'example.com', '--json']))

    expect(stop).toMatchObject({ code: 'GENERATIVE_AI_EXPORT_REFUSED', refusal: { _tag: 'not_generative_ai_report' } })
    expect(stop!.message).toContain('Generative AI features')
    expect(requests).toEqual([])
  })

  it('refuses an export with no page on the selected Site', async () => {
    const file = await writeExport({ ...EXPORT_FILES, 'Pages.csv': 'Top pages,Impressions\nhttps://other.test/,5' })
    const stop = await stopOf(run(['upload', file, '--site', 'example.com']))

    expect(stop).toMatchObject({ code: 'GENERATIVE_AI_EXPORT_REFUSED', message: 'This export has no pages on example.com. Select the Site that this export belongs to.' })
    expect(requests).toEqual([])
  })

  it('names a host that does not serve the operations yet', async () => {
    route = () => new Response('<html>Page not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    const stop = await stopOf(run(['upload', await writeExport(), '--site', 'example.com', '--json']))

    expect(stop).toMatchObject({ code: 'GENERATIVE_AI_UNAVAILABLE', nextCommand: null })
    expect(stop!.message).toContain('https://gscdump.com/api')
  })

  it('names a host that answers not implemented', async () => {
    route = () => new Response(null, { status: 501 })
    const stop = await stopOf(run(['list', '--site', 'example.com', '--json']))

    expect(stop).toMatchObject({ code: 'GENERATIVE_AI_UNAVAILABLE' })
  })

  it('names an unknown upload and points to the list', async () => {
    route = () => apiError(404, 'generative_ai_report_upload_not_found', 'Upload not found.')
    const stop = await stopOf(run(['remove', 'gau_missing', '--site', 'example.com', '--json']))

    expect(requests[0]).toMatchObject({ method: 'DELETE' })
    expect(requests[0]!.url.pathname).toBe('/api/partner/v1/sites/s_site/generative-ai/uploads/gau_missing')
    expect(stop).toMatchObject({ code: 'GENERATIVE_AI_UPLOAD_NOT_FOUND', nextCommand: 'gscdump generative-ai list --site s_site --json' })
  })

  it('returns the tagged no-upload read unchanged as JSON', async () => {
    const empty = { _tag: 'empty', report: 'search', reason: 'no-upload' }
    route = () => envelope(empty)
    await run(['show', '--site', 'example.com', '--json'])

    expect(JSON.parse(output.at(-1)!)).toEqual(empty)
  })

  it('tells a person how to export and upload when no upload exists', async () => {
    route = () => envelope({ _tag: 'empty', report: 'search', reason: 'no-upload' })
    await run(['show', '--site', 'example.com'])

    const printed = output.join('\n')
    expect(printed).toContain('Google has no API')
    expect(printed).toContain('Search Console > Performance > Generative AI features')
    expect(printed).toContain('gscdump generative-ai upload <zip> --site s_site')
    expect(printed).toContain('impressions only')
  })

  it('passes an exact page URL and upload id to the read', async () => {
    route = () => envelope({ _tag: 'empty', report: 'search', reason: 'no-upload' })
    await run(['show', '--site', 'example.com', '--page-url', 'https://example.com/guides/alpha', '--upload-id', 'gau_01', '--json'])

    expect(requests[0]!.url.pathname).toBe('/api/partner/v1/sites/s_site/generative-ai')
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({ pageUrl: 'https://example.com/guides/alpha', uploadId: 'gau_01' })
  })

  it('lists every upload for the Site', async () => {
    route = () => envelope({ uploads: [] })
    await run(['list', '--site', 'example.com', '--json'])

    expect(requests[0]!.url.pathname).toBe('/api/partner/v1/sites/s_site/generative-ai/uploads')
    expect(JSON.parse(output.at(-1)!)).toEqual({ uploads: [] })
  })
})
