import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createLocalStore } from '../src/local-store'

const execute = promisify(execFile)
const binary = fileURLToPath(new URL('../bin/gscdump.mjs', import.meta.url))

it('queries real Parquet files only after every date and search type is complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-coverage-'))
  try {
    const dataDir = join(directory, 'store')
    await writeFile(join(directory, 'config.json'), JSON.stringify({ dataDir }))
    const store = createLocalStore({ dataDir })
    const site = 'sc-domain:example.com'
    const scope = { userId: store.userId, siteId: store.siteIdFor(site), table: 'pages' as const }
    for (const date of ['2026-04-01', '2026-04-03']) {
      await store.engine.writeDay({ ...scope, date }, [{ date, url: '/a,b', clicks: 2, impressions: 4, sum_position: 0 }])
      await store.engine.setSyncState({ ...scope, date }, 'done')
    }
    // No Google credentials: a Site with no data for a search type must stop, not go live.
    const query = (flags: string[]) => execute(process.execPath, [binary, '--config-dir', directory, 'query', '--site', site, '--start', '2026-04-01', '--end', '2026-04-03', '-d', 'page', ...flags], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: '1' },
    }).then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }))
    const gap = await query(['-f', 'json'])
    expect(gap.code).toBe(1)
    expect(gap.stdout, gap.stderr).not.toBe('')
    expect(JSON.parse(gap.stdout).error.missingDates).toEqual(['2026-04-02'])
    // A completed zero-row day fills coverage without inventing traffic.
    await store.engine.setSyncState({ ...scope, date: '2026-04-02' }, 'done')
    const csv = await query(['-f', 'csv', '--quiet'])
    expect(csv.code, csv.stderr).toBe(0)
    expect(csv.stdout.trim()).toBe('page,clicks,impressions,ctr,position\n"/a,b",4,8,0.5,1')
    const image = await query(['--type', 'image', '-f', 'json'])
    expect(image.code).toBe(1)
    expect(JSON.parse(image.stdout).error).toMatchObject({ code: 'NOT_CONNECTED', nextCommand: 'gscdump init' })
    expect(image.stderr).toContain('no image pages data')
    expect(image.stderr).not.toContain('no pages data')
    for (const date of ['2026-04-01', '2026-04-02', '2026-04-03'])
      await store.engine.setSyncState({ ...scope, searchType: 'image', date }, 'done')
    const emptyImage = await query(['--type', 'image', '-f', 'json'])
    expect(emptyImage.code, emptyImage.stderr).toBe(0)
    expect(JSON.parse(emptyImage.stdout).data).toEqual([])
    await store.engine.setSyncState({ ...scope, date: '2026-04-02' }, 'failed', { error: 'Interrupted sync' })
    const failed = await query(['-f', 'json'])
    expect(failed.code).toBe(1)
    expect(JSON.parse(failed.stdout).error.missingDates).toEqual(['2026-04-02'])
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('resolves a case-mismatched exact Site hint from the Store instead of reporting a false coverage gap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-case-site-'))
  try {
    const dataDir = join(directory, 'store')
    await writeFile(join(directory, 'config.json'), JSON.stringify({ dataDir }))
    const store = createLocalStore({ dataDir })
    const scope = { userId: store.userId, siteId: store.siteIdFor('sc-domain:example.com'), table: 'pages' as const }
    for (const date of ['2026-04-01', '2026-04-02', '2026-04-03']) {
      await store.engine.writeDay({ ...scope, date }, [{ date, url: '/a,b', clicks: 2, impressions: 4, sum_position: 0 }])
      await store.engine.setSyncState({ ...scope, date }, 'done')
    }
    const query = await execute(process.execPath, [binary, '--config-dir', directory, 'query', '--site', 'sc-domain:Example.com', '--start', '2026-04-01', '--end', '2026-04-03', '-d', 'page', '-f', 'json', '--quiet'], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, GSC_ACCESS_TOKEN: 'unused-offline-token', NO_COLOR: '1' },
    }).then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }))
    expect(query.code, query.stderr).toBe(0)
    const payload = JSON.parse(query.stdout)
    expect(payload.siteUrl).toBe('sc-domain:example.com')
    expect(payload.data).toEqual([{ page: '/a,b', clicks: 6, impressions: 12, ctr: 0.5, position: 1 }])
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})
