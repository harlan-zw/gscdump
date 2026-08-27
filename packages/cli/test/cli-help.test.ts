import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'

vi.mock('../src/commands/query', () => {
  throw new Error('query implementation unavailable')
})

describe('cli help', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders root help without loading command implementations', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await runCli({
      rawArgs: ['--help'],
      loadEnv: false,
      environment: { NO_COLOR: '1' },
    })

    expect(output.join('\n')).toContain('query    Run a search analytics query (local Parquet by default, --live hits GSC API)')
  })

  it('renders nested command help through the shallow command', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await runCli({
      rawArgs: ['store', 'compact', '--help'],
      loadEnv: false,
      environment: { NO_COLOR: '1' },
    })

    expect(output.join('\n')).toContain('USAGE store compact [OPTIONS]')
  })

  it('dispatches command invocations through the shallow command', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))

    await runCli({
      rawArgs: ['--config-dir=/tmp/gscdump-cli-help', 'config', 'path'],
      loadEnv: false,
      environment: { NO_COLOR: '1' },
    })

    expect(output).toEqual(['/tmp/gscdump-cli-help/config.json'])
  })
})
