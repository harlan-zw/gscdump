import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setConfigDir } from '../config'
import { resolveCliEnvironment } from '../environment'
import { useCliRuntime } from '../runtime'

export const ROOT_DIR = path.join(os.homedir(), '.config', 'gscdump')
export const PROFILES_DIR = path.join(ROOT_DIR, 'profiles')
export const ACTIVE_MARKER = path.join(ROOT_DIR, 'active-profile')

export function getProfilesDir(): string {
  return PROFILES_DIR
}

export function getProfileDir(name: string): string {
  return path.join(PROFILES_DIR, name)
}

export function readActiveMarkerSync(): string | null {
  if (!fs.existsSync(ACTIVE_MARKER))
    return null
  const value = fs.readFileSync(ACTIVE_MARKER, 'utf-8').trim()
  return value || null
}

/**
 * Apply CLI-resolved config-dir / profile to the global config-dir state.
 * Priority: explicit --config-dir > --profile flag > GSCDUMP_PROFILE env > persisted active marker > root dir.
 */
export function applyProfileFromCli(opts: { configDir?: string | null, profile?: string | null, envProfile?: string | null }): void {
  if (opts.configDir) {
    setConfigDir(opts.configDir)
    useCliRuntime().configDirOverridden = true
    return
  }
  if (opts.profile) {
    useCliRuntime().activeProfileOverride = opts.profile
    setConfigDir(getProfileDir(opts.profile))
    return
  }
  const envProfile = opts.envProfile ?? resolveCliEnvironment().profile
  if (envProfile) {
    setConfigDir(getProfileDir(envProfile))
    return
  }
  const marker = readActiveMarkerSync()
  if (marker) {
    setConfigDir(getProfileDir(marker))
  }
}
