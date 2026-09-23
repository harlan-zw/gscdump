import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'

const prompts = vi.hoisted(() => ({
  text: vi.fn(() => {
    throw new Error('prompted')
  }),
  confirm: vi.fn(() => {
    throw new Error('prompted')
  }),
}))

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>()
  return { ...actual, text: prompts.text, confirm: prompts.confirm, password: prompts.text, select: prompts.text }
})

describe('init without a terminal', () => {
  let dir: string
  let output: string[]
  let exitCode: number | undefined
  const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-init-'))
    output = []
    exitCode = undefined
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
    // init reads a project .env from the working directory; keep it empty.
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    for (const method of ['log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => output.push(values.map(String).join(' ')))
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk) => {
        output.push(String(chunk))
        return true
      })
    }
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (isTTY)
      Object.defineProperty(process.stdin, 'isTTY', isTTY)
    else
      Reflect.deleteProperty(process.stdin, 'isTTY')
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function init(args: string[], environment: Record<string, string> = {}): Promise<void> {
    await runCli({ rawArgs: ['init', ...args], loadEnv: false, environment: { GSCDUMP_CONFIG_DIR: dir, ...environment } })
      .catch((error: Error) => {
        if (!error.message.startsWith('process.exit'))
          throw error
      })
  }

  async function saved(file: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
  }

  it('fails fast with the auth command when no credentials exist', async () => {
    await init([])

    expect(exitCode).toBe(1)
    expect(prompts.text).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain('gscdump auth login')
  })

  it('completes BYOK setup with the default data dir and prints the next commands', async () => {
    await init(['--mode', 'local'], { GSC_ACCESS_TOKEN: 'ya29.test' })

    expect(exitCode).toBeUndefined()
    expect(prompts.text).not.toHaveBeenCalled()
    expect(await saved('config.json')).toEqual({ dataDir: path.join(os.homedir(), '.gscdump', 'data') })
    expect(await saved('authentication.json')).toEqual({ _tag: 'Local' })
    expect(output.join('\n')).toContain('gscdump sync --site <site>')
  })

  it('saves cloud mode with an API key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      user: { publicId: 'u1', email: 'a@example.com' },
      sites: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await init(['--mode', 'cloud'], { GSCDUMP_API_KEY: 'gsd_user_test' })

    expect(exitCode).toBeUndefined()
    expect(await saved('authentication.json')).toEqual({ _tag: 'Cloud', apiKey: 'gsd_user_test', apiRoot: 'https://gscdump.com/api' })
  })
})
