import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { fileState } from './evidence.mjs'
import { run } from './runtime.mjs'

it('detects real Store file changes and deletions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-state-'))
  try {
    await writeFile(join(directory, 'rows'), 'original')
    const before = await fileState(directory)
    assert.deepEqual(await fileState(directory), before)
    await writeFile(join(directory, 'rows'), 'changed')
    assert.notDeepEqual(await fileState(directory), before)
    await rm(join(directory, 'rows'))
    assert.deepEqual(await fileState(directory), [])
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('regrades into separate evidence directories without rewriting the original', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-regrade-'))
  try {
    const original = JSON.stringify({ agentTrials: [{ id: 'negative-1', kind: 'negative', shouldTrigger: false }] })
    await writeFile(join(directory, 'report.json'), original)
    await writeFile(join(directory, 'negative-1-calls.json'), '[]')
    await writeFile(join(directory, 'negative-1-events.json'), '[]')
    for (let i = 0; i < 2; i++) {
      const result = await run(process.execPath, [new URL('./summarize.mjs', import.meta.url).pathname, directory])
      assert.equal(result.code, 0, result.stderr)
    }
    assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), original)
    const versions = await readdir(join(directory, 'regrades'))
    assert.equal(versions.length, 2)
    for (const version of versions) {
      const result = JSON.parse(await readFile(join(directory, 'regrades', version, 'report.json'), 'utf8'))
      assert.equal(result.trials[0].processGrade.passed, true)
      assert.equal(result.original.path, join(directory, 'report.json'))
      assert.match(result.original.sha256, /^[a-f0-9]{64}$/)
    }
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})
