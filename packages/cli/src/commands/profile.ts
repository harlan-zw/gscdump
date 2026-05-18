import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'
import { getConfigDir, setConfigDir } from '../config'
import { applyOutputMode, displayPath, logger, noSubcommandSelected, OUTPUT_ARGS } from '../utils'

const ROOT_DIR = path.join(os.homedir(), '.config', 'gscdump')
const PROFILES_DIR = path.join(ROOT_DIR, 'profiles')
const ACTIVE_MARKER = path.join(ROOT_DIR, 'active-profile')

let activeOverride: string | null = null
let configDirOverridden = false

export function getProfilesDir(): string {
  return PROFILES_DIR
}

export function getProfileDir(name: string): string {
  return path.join(PROFILES_DIR, name)
}

function readActiveMarkerSync(): string | null {
  if (!fs.existsSync(ACTIVE_MARKER))
    return null
  const v = fs.readFileSync(ACTIVE_MARKER, 'utf-8').trim()
  return v || null
}

export function resolveActiveProfile(): string | null {
  return activeOverride ?? process.env.GSCDUMP_PROFILE ?? readActiveMarkerSync()
}

/**
 * Apply CLI-resolved config-dir / profile to the global config-dir state.
 * Priority: explicit --config-dir > --profile flag > GSCDUMP_PROFILE env > persisted active marker > root dir.
 */
export function applyProfileFromCli(opts: { configDir?: string | null, profile?: string | null }): void {
  if (opts.configDir) {
    setConfigDir(opts.configDir)
    configDirOverridden = true
    return
  }
  if (opts.profile) {
    activeOverride = opts.profile
    setConfigDir(getProfileDir(opts.profile))
    return
  }
  const envProfile = process.env.GSCDUMP_PROFILE
  if (envProfile) {
    setConfigDir(getProfileDir(envProfile))
    return
  }
  const marker = readActiveMarkerSync()
  if (marker) {
    setConfigDir(getProfileDir(marker))
  }
}

export async function setActiveProfile(name: string | null): Promise<void> {
  await fsp.mkdir(ROOT_DIR, { recursive: true, mode: 0o700 })
  if (name == null) {
    await fsp.rm(ACTIVE_MARKER, { force: true }).catch(() => {})
    return
  }
  await fsp.writeFile(ACTIVE_MARKER, name, { mode: 0o600 })
}

export async function listProfiles(): Promise<string[]> {
  return fsp.readdir(PROFILES_DIR)
    .then(entries => entries.filter(e => !e.startsWith('.')).sort())
    .catch(() => [])
}

export async function createProfile(name: string): Promise<string> {
  const dir = getProfileDir(name)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function profileNameFromEmail(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * After a fresh login wrote tokens.json (and possibly config.json) into the
 * current config dir, relocate them under profiles/<name>/ and mark active.
 * No-op when --config-dir was used (user explicitly chose a path) or when a
 * profile is already active.
 */
export async function adoptCurrentConfigAsProfile(name: string): Promise<string | null> {
  if (configDirOverridden)
    return null
  if (resolveActiveProfile())
    return null
  const currentDir = getConfigDir()
  const targetDir = getProfileDir(name)
  if (currentDir === targetDir)
    return targetDir
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 })
  for (const f of ['tokens.json', 'config.json']) {
    const src = path.join(currentDir, f)
    const dst = path.join(targetDir, f)
    const exists = await fsp.stat(src).then(() => true).catch(() => false)
    if (exists)
      await fsp.rename(src, dst).catch(() => {})
  }
  await setActiveProfile(name)
  activeOverride = name
  setConfigDir(targetDir)
  return targetDir
}

const listCmd = defineCommand({
  meta: {
    name: 'list',
    description: 'List configured profiles',
  },
  args: {
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const names = await listProfiles()
    const active = resolveActiveProfile()
    if (json) {
      console.log(JSON.stringify({ active, profiles: names }, null, 2))
      return
    }
    if (names.length === 0) {
      logger.warn(`No profiles in ${PROFILES_DIR}`)
      logger.info('Run `gscdump auth login` to create one automatically, or `gscdump profile create <name>`')
      return
    }
    for (const n of names) {
      const marker = n === active ? '*' : ' '
      console.log(`${marker} ${n}`)
    }
  },
})

const pathCmd = defineCommand({
  meta: {
    name: 'path',
    description: 'Print the config directory for a profile',
  },
  args: {
    name: { type: 'positional', required: false, description: 'Profile name (default: active)' },
  },
  async run({ args }) {
    const name = args.name ? String(args.name) : resolveActiveProfile()
    if (!name) {
      logger.error('No profile specified and none active (set --profile, GSCDUMP_PROFILE, or run `gscdump profile use <name>`)')
      process.exit(1)
    }
    console.log(getProfileDir(name))
  },
})

const currentCmd = defineCommand({
  meta: {
    name: 'current',
    description: 'Print the active profile name',
  },
  async run() {
    const active = resolveActiveProfile()
    if (!active)
      process.exit(1)
    console.log(active)
  },
})

const useCmd = defineCommand({
  meta: {
    name: 'use',
    description: 'Set the persisted active profile (subsequent commands no longer need --profile)',
  },
  args: {
    ...OUTPUT_ARGS,
    name: { type: 'positional', required: true, description: 'Profile name' },
  },
  async run({ args }) {
    applyOutputMode(args)
    const name = String(args.name)
    const dir = getProfileDir(name)
    const exists = await fsp.stat(dir).then(() => true).catch(() => false)
    if (!exists) {
      logger.error(`Profile not found: ${name}`)
      logger.info(`Create it with: gscdump profile create ${name}`)
      process.exit(1)
    }
    await setActiveProfile(name)
    logger.success(`Active profile: ${name}`)
  },
})

const createCmd = defineCommand({
  meta: {
    name: 'create',
    description: 'Create an empty profile directory',
  },
  args: {
    ...OUTPUT_ARGS,
    'name': { type: 'positional', required: true, description: 'Profile name' },
    'no-use': { type: 'boolean', default: false, description: 'Do not mark the new profile as active' },
  },
  async run({ args }) {
    applyOutputMode(args)
    const name = String(args.name)
    const dir = await createProfile(name)
    if (!args['no-use'])
      await setActiveProfile(name)
    logger.success(`Created profile: ${name}${args['no-use'] ? '' : ' (active)'}`)
    logger.info(displayPath(dir))
  },
})

const clearCmd = defineCommand({
  meta: {
    name: 'clear',
    description: 'Clear the persisted active profile (commands fall back to root config dir)',
  },
  args: {
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    await setActiveProfile(null)
    logger.success('Cleared active profile')
  },
})

const deleteCmd = defineCommand({
  meta: {
    name: 'delete',
    description: 'Remove a profile directory (tokens + config)',
  },
  args: {
    ...OUTPUT_ARGS,
    name: { type: 'positional', required: true, description: 'Profile name' },
    yes: { type: 'boolean', alias: 'y', default: false, description: 'Skip confirmation' },
  },
  async run({ args }) {
    applyOutputMode(args)
    const name = String(args.name)
    const dir = getProfileDir(name)
    const exists = await fsp.stat(dir).then(() => true).catch(() => false)
    if (!exists) {
      logger.error(`Profile not found: ${name}`)
      process.exit(1)
    }
    if (!args.yes) {
      const ok = await confirm({
        message: `Delete profile "${name}" at ${dir}? Tokens and config will be lost.`,
        initialValue: false,
      })
      if (isCancel(ok) || !ok) {
        logger.info('Cancelled')
        process.exit(0)
      }
    }
    await fsp.rm(dir, { recursive: true, force: true })
    if (readActiveMarkerSync() === name)
      await setActiveProfile(null)
    logger.success(`Removed profile: ${name}`)
  },
})

export const profileCommand = defineCommand({
  meta: {
    name: 'profile',
    description: 'Manage gscdump profiles (per-account token + config dirs)',
  },
  subCommands: {
    list: listCmd,
    path: pathCmd,
    current: currentCmd,
    use: useCmd,
    create: createCmd,
    clear: clearCmd,
    delete: deleteCmd,
  },
  // No subcommand: list profiles.
  async run({ args }) {
    if (!noSubcommandSelected('profile', ['list', 'path', 'current', 'use', 'create', 'clear', 'delete']))
      return
    await listCmd.run?.({ args, cmd: listCmd, rawArgs: [] } as any)
  },
})
