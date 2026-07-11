import type { CliRuntime } from './runtime'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { applyProfileFromCli } from './commands/profile'
import { loadEnvFromCwd } from './env-file'
import { resolveCliEnvironment } from './environment'
import { createCliRuntime, runWithCliRuntime } from './runtime'
import { configureColor, showSplash, VERSION, withConfiguredOutput } from './utils'

// Splash is purely cosmetic; suppress whenever it would corrupt machine output
// or be spammed across non-interactive runs.
function shouldShowSplash(rawArgs: string[]): boolean {
  if (!process.stdout.isTTY)
    return false
  if (rawArgs.includes('mcp'))
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
  const env = resolveCliEnvironment()
  configureColor({
    noColor: rawArgs.includes('--no-color') || env.noColor,
    forceColor: env.forceColor,
    stderrIsTTY: Boolean(process.stderr.isTTY),
  })

  const profile = pluckArgValue(rawArgs, '--profile')
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
function pluckArgValue(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === flag && i + 1 < argv.length) {
      const v = argv[i + 1]
      argv.splice(i, 2)
      return v
    }
    if (a.startsWith(`${flag}=`)) {
      const v = a.slice(flag.length + 1)
      argv.splice(i, 1)
      return v
    }
  }
  return null
}

export const main = defineCommand({
  meta: {
    name: 'gscdump',
    version: VERSION,
    description: 'Google Search Console Data Extractor',
  },
  subCommands: {
    init: () => import('./commands/init').then(m => m.initCommand),
    dump: () => import('./commands/dump').then(m => m.dumpCommand),
    query: () => import('./commands/query').then(m => m.queryCommand),
    sites: () => import('./commands/sites').then(m => m.sitesCommand),
    sitemaps: () => import('./commands/sitemaps').then(m => m.sitemapsCommand),
    sync: () => import('./commands/sync').then(m => m.syncCommand),
    store: () => import('./commands/store').then(m => m.storeCommand),
    inspect: () => import('./commands/inspect').then(m => m.inspectCommand),
    indexing: () => import('./commands/indexing').then(m => m.indexingCommand),
    entities: () => import('./commands/entities').then(m => m.entitiesCommand),
    analyze: () => import('./commands/analyze').then(m => m.analyzeCommand),
    report: () => import('./commands/report').then(m => m.reportCommand),
    auth: () => import('./commands/auth').then(m => m.authCommand),
    // Aliases: `gscdump login` etc. routed to the same subcommands.
    login: () => import('./commands/auth').then(m => m.loginCommand),
    logout: () => import('./commands/auth').then(m => m.logoutCommand),
    status: () => import('./commands/auth').then(m => m.statusCommand),
    config: () => import('./commands/config').then(m => m.configCommand),
    profile: () => import('./commands/profile').then(m => m.profileCommand),
    doctor: () => import('./commands/doctor').then(m => m.doctorCommand),
    mcp: () => import('./commands/mcp').then(m => m.mcpCommand),
  },
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

export async function runCli(opts: RunCliOptions = {}): Promise<void> {
  const input = opts.rawArgs ?? process.argv.slice(2)
  const runtime = opts.runtime ?? createCliRuntime({ environment: opts.environment, rawArgs: input })
  runtime.rawArgs = [...input]
  await runWithCliRuntime(runtime, async () => {
    if (opts.loadEnv !== false)
      loadEnvFromCwd()
    const rawArgs = prepareCliArgs(input)
    runtime.rawArgs = [...rawArgs]
    await withConfiguredOutput(() => runMain(main, { rawArgs }))
  })
}

export { createCliRuntime }
export type { CliRuntime, CreateCliRuntimeOptions } from './runtime'
