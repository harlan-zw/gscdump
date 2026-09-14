import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { checkScope } from './policy.mjs'
import { run } from './runtime.mjs'

it('accepts safe equals and short options while rejecting scope escapes', () => {
  const settings = { site: 'sc-domain:example.com', start: '2026-08-01', end: '2026-08-01', workspace: '/tmp/eval' }
  assert.equal(checkScope(['query', '-s', settings.site, '-d', 'page', '--format=json'], settings).reason, null)
  assert.equal(checkScope(['sync', `--site=${settings.site}`, `--start=${settings.start}`, `--end=${settings.end}`, '--tables=pages'], settings).reason, null)
  for (const args of [['query', '-s', 'sc-domain:outside.com'], ['query', '--profile=real'], ['query', '-o', '../outside.json'], ['query', '-s', settings.site, '--site=outside']])
    assert(checkScope(args, settings).reason)
})

it('reserves at most one sync across real concurrent processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-reservation-'))
  try {
    const module = new URL('./reservation.mjs', import.meta.url).href
    const script = `import { reserve } from ${JSON.stringify(module)}; const result = await reserve(process.argv[1], {sync:true,reason:null}, 20); console.log(JSON.stringify(result))`
    const results = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', script, directory])))
    for (const result of results)
      assert.equal(result.code, 0, result.stderr)
    assert.equal(results.filter(result => JSON.parse(result.stdout).reason === null).length, 1)
    assert.equal((await readFile(join(directory, 'reservations.jsonl'), 'utf8')).trim().split('\n').length, 8)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('counts a sync when boolean flags explicitly disable status or dry-run', () => {
  const settings = { site: 'sc-domain:example.com', start: '2026-08-01', end: '2026-08-01', workspace: '/tmp/eval' }
  const args = ['sync', '--site', settings.site, '--start', settings.start, '--end', settings.end, '--tables', 'pages']
  for (const flags of [['--status=false'], ['--dry-run=false'], ['--status', '--no-status']])
    assert.equal(checkScope([...args, ...flags], settings).sync, true)
})
