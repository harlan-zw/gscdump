import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { it } from 'vitest'
import { killProcessGroup, run } from './runtime.mjs'

it('survives a kill against an already-reaped detached process group', async () => {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
  await new Promise(resolve => child.once('exit', resolve))
  assert.doesNotThrow(() => killProcessGroup(child))
})

it('resolves a timed-out child as 124 through the guarded kill', async () => {
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { timeout: 50 })
  assert.equal(result.code, 124)
})
