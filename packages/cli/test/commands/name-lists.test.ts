import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'

const context = vi.hoisted(() => vi.fn())
vi.mock('../../src/context', () => ({ createCommandContext: context }))

let configDir: string
const errors: string[] = []

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-names-'))
  errors.length = 0
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')))
  context.mockRejectedValue(new Error('Context started'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(configDir, { recursive: true, force: true })
})

it.each([
  [['sync', '--tables', 'pages,bogus'], 'Unknown --tables name: bogus. Valid names: pages, queries'],
  [['sync', '--types', 'web,bogus'], 'Unknown --types name: bogus. Valid names: web, image'],
  [['dump', '--tables', 'pagez'], 'Unknown --tables name: pagez. Valid names: pages, queries'],
])('rejects an unknown name before any work: %j', async (args, message) => {
  expect(await runCli({ rawArgs: ['--config-dir', configDir, ...args], loadEnv: false, environment: {} })).toBe(1)
  expect(errors.join('\n')).toContain(message)
  expect(context).not.toHaveBeenCalled()
})
