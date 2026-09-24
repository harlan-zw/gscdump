import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const execute = promisify(execFile)
const directories: string[] = []
const binary = fileURLToPath(new URL('../bin/gscdump.mjs', import.meta.url))

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function invoke(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-agent-test-'))
  directories.push(directory)
  await writeFile(join(directory, 'config.json'), JSON.stringify({ dataDir: join(directory, 'store') }))
  return execute(process.execPath, [binary, '--config-dir', directory, ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: '1' },
  }).then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }))
}

it.each([
  ['query', '--metrics', 'clicks,impressions', '--format', 'json'],
  ['store', 'stats', '--jsno'],
  ['sync', '--staus'],
])('rejects unknown flags before auth or Store work: %j', async (...args) => {
  const result = await invoke(args)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Unknown option')
  expect(result.stderr).not.toMatch(/credentials|authenticate/i)
})

it.each([['store', 'stats'], ['store']])('rejects an unsynced Site instead of printing empty Store metadata: %j', async (...command) => {
  const result = await invoke([...command, '--site', 'sc-domain:example.com', '--json'])
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('The Store has no data. Run `gscdump sync --site example.com` first.')
})

it('suggests the unique full option name before authentication', async () => {
  const result = await invoke(['query', '--dimension', 'page'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Use --dimensions.')
  expect(result.stderr).not.toMatch(/credentials|authenticate/i)
})
