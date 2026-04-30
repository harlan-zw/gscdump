#!/usr/bin/env node

import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { analyzeCommand } from './commands/analyze'
import { authCommand } from './commands/auth'
import { configCommand } from './commands/config'
import { doctorCommand } from './commands/doctor'
import { dumpCommand } from './commands/dump'
import { entitiesCommand } from './commands/entities'
import { indexingCommand } from './commands/indexing'
import { initCommand } from './commands/init'
import { inspectCommand } from './commands/inspect'
import { mcpCommand } from './commands/mcp'
import { queryCommand } from './commands/query'
import { sitemapsCommand } from './commands/sitemaps'
import { sitesCommand } from './commands/sites'
import { storeCommand } from './commands/store'
import { syncCommand } from './commands/sync'
import { setConfigDir } from './config'
import { loadEnvFromCwd } from './env-file'
import { setNoColor, showSplash, VERSION } from './utils'

// Splash is purely cosmetic; suppress whenever it would corrupt machine output
// or be spammed across non-interactive runs.
function shouldShowSplash(): boolean {
  if (!process.stdout.isTTY)
    return false
  const argv = process.argv
  if (argv.includes('mcp'))
    return false
  for (const flag of ['--json', '--quiet', '-q', '--version', '-v', '--help', '-h']) {
    if (argv.includes(flag))
      return false
  }
  return true
}

// Top-level args are scoped to subcommands in citty, so we hoist a few global
// flags (--config-dir, --profile, --no-color) by reading argv directly and
// stripping them before citty parses. Env vars provide the same controls.
function applyGlobalArgs(): void {
  const argv = process.argv
  if (argv.includes('--no-color') || process.env.NO_COLOR)
    setNoColor(true)

  const profile = pluckArgValue(argv, '--profile') ?? process.env.GSCDUMP_PROFILE
  const configDir = pluckArgValue(argv, '--config-dir') ?? process.env.GSCDUMP_CONFIG_DIR

  if (configDir) {
    setConfigDir(configDir)
  }
  else if (profile) {
    // Profiles live under ~/.config/gscdump/profiles/<name>; tokens.json and
    // config.json are isolated per profile, letting users juggle accounts.
    setConfigDir(path.join(os.homedir(), '.config', 'gscdump', 'profiles', profile))
  }

  // -v as an alias for --version (citty doesn't auto-add it).
  if (argv.includes('-v') && !argv.includes('--version')) {
    const i = argv.indexOf('-v')
    argv[i] = '--version'
  }
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

applyGlobalArgs()
loadEnvFromCwd()

const main = defineCommand({
  meta: {
    name: 'gscdump',
    version: VERSION,
    description: 'Google Search Console Data Extractor',
  },
  subCommands: {
    init: initCommand,
    dump: dumpCommand,
    query: queryCommand,
    sites: sitesCommand,
    sitemaps: sitemapsCommand,
    sync: syncCommand,
    store: storeCommand,
    inspect: inspectCommand,
    indexing: indexingCommand,
    entities: entitiesCommand,
    analyze: analyzeCommand,
    auth: authCommand,
    config: configCommand,
    doctor: doctorCommand,
    mcp: mcpCommand,
  },
  setup() {
    if (shouldShowSplash())
      showSplash()
  },
})

runMain(main)
