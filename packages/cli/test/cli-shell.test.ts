import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'

const runs = vi.hoisted(() => ({
  profile: vi.fn(),
  profileList: vi.fn(),
  indexing: vi.fn(),
  snapshot: vi.fn(),
  install: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../src/commands/profile', () => ({
  profileCommand: {
    args: { json: { type: 'boolean' } },
    subCommands: { list: { args: { json: { type: 'boolean' } }, run: runs.profileList } },
    run: runs.profile,
  },
}))
vi.mock('../src/commands/skill', () => ({
  skillCommand: { meta: { name: 'skill' }, subCommands: { install: { meta: { name: 'install' }, run: runs.install } } },
}))
vi.mock('../src/commands/entities', () => ({
  entitiesCommand: {
    meta: { name: 'entities' },
    subCommands: {
      indexing: { meta: { name: 'indexing' }, subCommands: { snapshot: { run: runs.snapshot } }, run: runs.indexing },
    },
  },
}))
vi.mock('../src/commands/query', () => ({
  queryCommand: { args: { url: { type: 'positional', required: true } }, run: runs.query },
}))

const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
const errors: string[] = []

beforeEach(() => {
  errors.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')))
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  if (stderrTTY)
    Object.defineProperty(process.stderr, 'isTTY', stderrTTY)
  else
    Reflect.deleteProperty(process.stderr, 'isTTY')
})

const cli = (rawArgs: string[], environment: Record<string, string> = {}) => runCli({ rawArgs, loadEnv: false, environment })

describe('subcommand dispatch', () => {
  it('runs only the subcommand, never its parent', async () => {
    expect(await cli(['profile', 'list', '--json'])).toBe(0)
    expect(runs.profileList).toHaveBeenCalledOnce()
    expect(runs.profile).not.toHaveBeenCalled()
  })

  it('runs the parent when no subcommand is given', async () => {
    expect(await cli(['profile', '--json'])).toBe(0)
    expect(runs.profile).toHaveBeenCalledOnce()
    expect(runs.profileList).not.toHaveBeenCalled()
  })

  it('rejects a flag placed before the subcommand instead of running twice', async () => {
    expect(await cli(['profile', '--json', 'list'])).toBe(1)
    expect(runs.profile).not.toHaveBeenCalled()
    expect(runs.profileList).not.toHaveBeenCalled()
    expect(errors.join('\n')).toContain('Put --json after the subcommand: gscdump profile list --json.')
  })

  it('applies the same rule to nested commands', async () => {
    expect(await cli(['entities', 'indexing', 'snapshot'])).toBe(0)
    expect(runs.snapshot).toHaveBeenCalledOnce()
    expect(runs.indexing).not.toHaveBeenCalled()
  })

  it.each([[['skill']], [['entities']]])('shows usage and exits 1 for a bare parent with no action: %j', async (rawArgs) => {
    expect(await cli(rawArgs)).toBe(1)
    const text = errors.join('\n')
    expect(text).toContain('USAGE')
    expect(text).toContain('No command specified.')
    expect(runs.install).not.toHaveBeenCalled()
  })
})

describe('error shell', () => {
  it('prints an expected error as one line without a stack', async () => {
    runs.query.mockRejectedValue(new Error('The Store has no data for this Site.'))
    expect(await cli(['query', 'x'])).toBe(1)
    expect(errors).toEqual(['Error: The Store has no data for this Site.'])
  })

  it('prints a stack for a defect', async () => {
    runs.query.mockImplementation(() => {
      throw new TypeError('Cannot read properties of undefined')
    })
    expect(await cli(['query', 'x'])).toBe(1)
    expect(errors.join('\n')).toMatch(/TypeError: Cannot read properties of undefined\n\s+at /)
  })

  it('shows usage for a citty argument error', async () => {
    expect(await cli(['query'])).toBe(1)
    expect(errors.join('\n')).toContain('Missing required positional argument: URL')
    expect(errors.join('\n')).toContain('USAGE')
  })

  it.each([
    ['a terminal with NO_COLOR', true, { NO_COLOR: '1' }],
    ['a pipe', false, {}],
  ])('writes no ANSI codes to %s', async (_label, isTTY, environment) => {
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: isTTY })
    runs.query.mockRejectedValue(new Error('boom'))
    expect(await cli(['query', 'x'], environment)).toBe(1)
    // eslint-disable-next-line no-control-regex
    expect(errors.join('\n')).not.toMatch(/\x1B\[/)
  })

  it('colors the error in a terminal', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true })
    runs.query.mockRejectedValue(new Error('boom'))
    await cli(['query', 'x'])
    expect(errors.join('\n')).toContain('\x1B[31mError: boom')
  })
})
