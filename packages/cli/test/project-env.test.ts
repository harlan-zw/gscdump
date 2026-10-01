import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'

// A project's `.env` holds that project's credentials. Running gscdump inside
// the project must never send them anywhere.
let directory: string
let requests: string[]

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-project-env-'))
  requests = []
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    requests.push(input instanceof Request ? input.url : String(input))
    return Response.json({ error: 'unexpected request' }, { status: 500 })
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

it.each([
  ['a gscdump API key', 'GSCDUMP_API_KEY=gsd_user_project\nGSCDUMP_API_ROOT=https://project.example/api\n'],
  ['a Google access token', 'GSC_ACCESS_TOKEN=ya29.project-token\n'],
])('never uses %s from a .env file in the current directory', async (_label, contents) => {
  await fs.writeFile(path.join(directory, '.env'), contents)
  const code = await runCli({ rawArgs: ['sites', '--json'], environment: { GSCDUMP_CONFIG_DIR: path.join(directory, 'config') } })

  expect(code).toBe(1)
  expect(requests).toEqual([])
})
