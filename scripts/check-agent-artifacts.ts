import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)
const scratchRoot = path.join(os.homedir(), 'scratch')
await mkdir(scratchRoot, { recursive: true })
const target = await mkdtemp(path.join(scratchRoot, 'gscdump-agent-artifacts-'))
const cli = path.join(root, 'packages/cli/bin/gscdump.mjs')

async function run(...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execute(process.execPath, [cli, ...args], { cwd: root, timeout: 30_000 })
  return JSON.parse(stdout)
}

try {
  const installed = await run('skill', 'install', '--agent', 'codex', '--target', target, '--json')
  assert.equal(typeof installed.digest, 'string')
  const status = await run('skill', 'status', '--agent', 'codex', '--target', target, '--json')
  assert.equal(status.state, 'current')
  assert.equal(status.installedDigest, installed.digest)
  await appendFile(path.join(target, 'gscdump/references/hosted-inspection.md'), '\nArtifact regression probe.\n')
  assert.equal((await run('skill', 'status', '--agent', 'codex', '--target', target, '--json')).state, 'stale')
  await run('skill', 'install', '--agent', 'codex', '--target', target, '--json')
  assert.equal((await run('skill', 'status', '--agent', 'codex', '--target', target, '--json')).state, 'current')
  console.log('Agent artifact gate passed: install, complete digest, reference drift, and refresh.')
}
finally {
  await rm(target, { recursive: true, force: true })
}
