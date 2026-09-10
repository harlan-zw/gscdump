import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'
import { cyan } from '../src/utils'

vi.mock('../src/commands/query', () => ({
  queryCommand: {
    args: { format: { type: 'string' } },
    run: ({ args }: { args: { format?: string } }) => console.log(args.format === 'json' ? '{"clicks":12}' : cyan('chart')),
  },
}))
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
afterEach(() => {
  vi.restoreAllMocks()
  for (const [stream, descriptor] of [[process.stdout, stdoutTTY], [process.stderr, stderrTTY]] as const) {
    if (descriptor)
      Object.defineProperty(stream, 'isTTY', descriptor)
    else
      Reflect.deleteProperty(stream, 'isTTY')
  }
})

async function capture(stdout: boolean, stderr: boolean, args: string[] = []) {
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdout })
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: stderr })
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  await runCli({ rawArgs: ['query', ...args], environment: {}, loadEnv: false })
  return lines.join('\n')
}

describe('cLI output streams', () => {
  it('keeps stdout color when only stderr is redirected', async () => {
    expect(await capture(true, false)).toContain('\x1B[36mchart')
  })
  it('removes stdout color when only stdout is redirected', async () => {
    expect(await capture(false, true)).toBe('chart')
  })
  it('keeps explicit JSON clean in a terminal', async () => {
    expect(JSON.parse(await capture(true, true, ['--format=json']))).toEqual({ clicks: 12 })
  })
})
