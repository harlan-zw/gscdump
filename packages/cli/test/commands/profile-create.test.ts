import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'

// Profiles live under ~/.config/gscdump no matter what --config-dir says, and
// the path is fixed at import. Point HOME at a scratch dir before any import.
const home = vi.hoisted(() => {
  // eslint-disable-next-line ts/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line ts/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/gscdump-profile-home-`)
  process.env.HOME = dir
  return dir
})

let root: string
const output: string[] = []

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-profile-test-'))
  output.length = 0
  vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(path.join(home, '.config'), { recursive: true, force: true })
})

async function activeProfile(): Promise<string | null> {
  output.length = 0
  await runCli({ rawArgs: ['--config-dir', root, 'profile', 'list', '--json'], loadEnv: false, environment: {} })
  return JSON.parse(output.join('\n')).active
}

it('makes a new profile active by default', async () => {
  expect(await runCli({ rawArgs: ['--config-dir', root, 'profile', 'create', 'work'], loadEnv: false, environment: {} })).toBe(0)
  expect(await activeProfile()).toBe('work')
})

it('leaves the active profile alone with --no-use', async () => {
  expect(await runCli({ rawArgs: ['--config-dir', root, 'profile', 'create', 'work', '--no-use'], loadEnv: false, environment: {} })).toBe(0)
  expect(await activeProfile()).toBeNull()
})
