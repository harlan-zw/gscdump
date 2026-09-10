import type { CliRuntime } from '../src/cli'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCliRuntime, runCli } from '../src/cli'

const run = vi.hoisted(() => vi.fn())
vi.mock('../src/commands/query', () => ({
  queryCommand: {
    args: { profile: { type: 'boolean' }, quiet: { type: 'boolean' } },
    run,
  },
}))

describe('global CLI flags', () => {
  afterEach(() => vi.clearAllMocks())

  it('preserves query timing and the following boolean flag', async () => {
    const runtime: CliRuntime = createCliRuntime({ environment: {} })
    await runCli({ rawArgs: ['query', '--profile', '--quiet'], runtime, loadEnv: false })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ profile: true, quiet: true }) }))
    expect(runtime.activeProfileOverride).toBeNull()
  })

  it('selects an account profile when the global flag has a value', async () => {
    const runtime = createCliRuntime({ environment: {} })
    await runCli({ rawArgs: ['--profile', 'work', 'query', '--quiet'], runtime, loadEnv: false })
    expect(runtime.activeProfileOverride).toBe('work')
    expect(run).toHaveBeenCalledOnce()
  })

  it.each([
    ['--config-dir'],
    ['--config-dir', '--help'],
    ['--config-dir='],
    ['--profile'],
    ['--profile='],
  ])('rejects a global flag without a value: %j', async (...rawArgs) => {
    await expect(runCli({ rawArgs, loadEnv: false, environment: {} })).rejects.toThrow(/requires a value/)
  })
})
