import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const binary = fileURLToPath(new URL('../bin/gscdump.mjs', import.meta.url))

const INSPECTED = 20
const TOTAL = 25

// A quota stop forces exit 1 after the --json payload is printed. The URL
// list plus 150 referring URLs per result push the payload past the 64 KiB
// pipe buffer, so a hard exit would truncate it mid-flight.
it('drains piped JSON before a failed run exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-bin-exit-'))
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ dataDir: join(directory, 'store') }))
    const preload = join(directory, 'mock-gsc.mjs')
    await writeFile(preload, `
const realFetch = globalThis.fetch
let calls = 0
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/webmasters/v3/sites'))
    return Response.json({ siteEntry: [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }] })
  if (url.includes('urlInspection/index:inspect')) {
    calls++
    if (calls > ${INSPECTED}) {
      return Response.json(
        { error: { code: 429, message: 'Quota exceeded for quota metric "Read requests".' } },
        { status: 429, headers: { 'retry-after': '0' } },
      )
    }
    const referringUrls = Array.from({ length: 150 }, (_, i) => \`https://referrer.example.com/page-\${calls}-\${i}\`)
    return Response.json({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', referringUrls } } })
  }
  return realFetch(input, init)
}
`)
    const urls = Array.from({ length: TOTAL }, (_, i) => `https://example.com/page-${i + 1}`)
    const result = await execute(
      process.execPath,
      ['--import', pathToFileURL(preload).href, binary, '--config-dir', directory, 'inspect', ...urls, '--site', 'https://example.com/', '--json'],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, GSC_ACCESS_TOKEN: 'unused-offline-token', NO_COLOR: '1' },
      },
    ).then(
      r => ({ code: 0, ...r }),
      e => ({ code: e.code, stdout: String(e.stdout), stderr: String(e.stderr) }),
    )
    expect(result.code, result.stderr).toBe(1)
    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({
      site: 'https://example.com/',
      inspected: INSPECTED,
      failed: 0,
      remaining: TOTAL - INSPECTED,
    })
    expect(payload.results).toHaveLength(INSPECTED)
    expect(payload.results[0]).toMatchObject({ url: 'https://example.com/page-1', status: 'inspected', isIndexed: true })
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
