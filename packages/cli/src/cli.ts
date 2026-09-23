import type { CliRuntime } from './runtime'
import process from 'node:process'
import { defineCommand, renderUsage, runCommand } from 'citty'
import { parseAuthMode } from './auth-state'
import { checkCliArgs } from './cli-args'
import { CLI_SUBCOMMANDS, resolveUsageTarget } from './command-registry'
import { applyProfileFromCli } from './commands/profile-selection'
import { loadEnvFromCwd } from './env-file'
import { resolveCliEnvironment } from './environment'
import { reportCliError } from './error-handler'
import { resolveOutputOptions, terminalOutputOptions } from './render/terminal'
import { createCliRuntime, runWithCliRuntime, useCliRuntime } from './runtime'
import { setNoColor, showSplash, VERSION, withConfiguredOutput } from './utils'

// Splash is purely cosmetic; suppress whenever it would corrupt machine output
// or be spammed across non-interactive runs.
function shouldShowSplash(rawArgs: string[]): boolean {
  if (!process.stdout.isTTY)
    return false
  // Data commands own their headings, including JSON and CSV formats.
  if (rawArgs[0] !== 'init' && rawArgs[0] !== 'auth')
    return false
  for (const flag of ['--json', '--quiet', '-q', '--version', '-v', '--help', '-h']) {
    if (rawArgs.includes(flag))
      return false
  }
  return true
}

// Top-level args are scoped to subcommands in citty, so we hoist a few global
// flags (--config-dir, --profile, --no-color) by reading argv directly and
// stripping them before citty parses. Env vars provide the same controls.
function prepareCliArgs(input: readonly string[]): string[] {
  const rawArgs = [...input]
  useCliRuntime().authModeOverride = parseAuthMode(pluckArgValue(rawArgs, '--mode') ?? undefined)
  const env = resolveCliEnvironment()
  setNoColor(!terminalOutputOptions().color)

  const profile = pluckArgValue(rawArgs, '--profile', true)
  const configDir = pluckArgValue(rawArgs, '--config-dir') ?? env.configDir ?? null

  // Profiles live under ~/.config/gscdump/profiles/<name>; tokens.json and
  // config.json are isolated per profile, letting users juggle accounts.
  // The profile module owns the resolution: --profile flag > GSCDUMP_PROFILE
  // env > persisted active marker > root dir.
  applyProfileFromCli({ configDir, profile, envProfile: env.profile })

  // -v as an alias for --version (citty doesn't auto-add it).
  if (rawArgs.includes('-v') && !rawArgs.includes('--version')) {
    const i = rawArgs.indexOf('-v')
    rawArgs[i] = '--version'
  }
  return rawArgs
}

// Splice out `--flag value` pairs (and `--flag=value`) from argv so citty
// doesn't see them; returns the value or null.
function pluckArgValue(argv: string[], flag: string, allowQueryTiming = false): string | null {
  let value: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--')
      break
    if (a !== flag && !a.startsWith(`${flag}=`))
      continue
    const inline = a !== flag
    const next = inline ? a.slice(flag.length + 1) : argv[i + 1]
    if (!inline && allowQueryTiming && argv.includes('query') && argv.indexOf('query') < i
      && (next === undefined || next.startsWith('-'))) {
      continue
    }
    if (!next || (!inline && next.startsWith('-')))
      throw new Error(`${flag} requires a value. Use ${flag}=VALUE.`)
    value = next
    argv.splice(i, inline ? 1 : 2)
    i--
  }
  return value
}

export const main = defineCommand({
  meta: {
    name: 'gscdump',
    version: VERSION,
    description: 'Google Search Console Data Extractor',
  },
  subCommands: CLI_SUBCOMMANDS,
  setup({ rawArgs }) {
    if (shouldShowSplash(rawArgs))
      showSplash()
  },
})

export interface RunCliOptions {
  rawArgs?: string[]
  loadEnv?: boolean
  environment?: Record<string, string | undefined>
  runtime?: CliRuntime
}

const HELP_FLAGS = new Set(['--help', '-h'])

async function runMainCommand(rawArgs: string[]): Promise<void> {
  if (rawArgs.some(arg => HELP_FLAGS.has(arg))) {
    console.log(`${await renderUsage(...await resolveUsageTarget(main, rawArgs))}\n`)
    return
  }
  if (rawArgs.length === 1 && rawArgs[0] === '--version') {
    console.log(VERSION)
    return
  }
  await runCommand(main, { rawArgs })
}

function stderrColor(runtime: CliRuntime, rawArgs: readonly string[]): boolean {
  return resolveOutputOptions({
    isTTY: process.stderr.isTTY,
    environment: runtime.environment,
    noColor: rawArgs.includes('--no-color'),
  }).color
}

/**
 * Run one CLI invocation. Every failure ends here: the shell prints it once
 * and returns exit code 1. The caller owns `process.exit`.
 */
export async function runCli(opts: RunCliOptions = {}): Promise<number> {
  const input = opts.rawArgs ?? process.argv.slice(2)
  const runtime = opts.runtime ?? createCliRuntime({ environment: opts.environment, rawArgs: input })
  runtime.rawArgs = [...input]
  return runWithCliRuntime(runtime, async () => {
    let rawArgs = [...input]
    try {
      if (opts.loadEnv !== false)
        loadEnvFromCwd()
      rawArgs = prepareCliArgs(input)
      runtime.rawArgs = [...rawArgs]
      const argumentError = await checkCliArgs(main, rawArgs)
      if (argumentError)
        throw new Error(argumentError)
      await withConfiguredOutput(() => runMainCommand(rawArgs))
      return 0
    }
    catch (error) {
      await reportCliError(error, {
        color: stderrColor(runtime, rawArgs),
        usage: async () => renderUsage(...await resolveUsageTarget(main, rawArgs)),
        // Loaded on demand: the auth module is heavy and only an auth failure needs it.
        authSources: async () => (await import('./auth')).formatAuthProvenance(),
      })
      return 1
    }
  })
}

export { createCliRuntime }
export type { CliRuntime, CreateCliRuntimeOptions } from './runtime'
