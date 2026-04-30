import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ENV_LINE_RE = /^([^=]+)=(.*)$/

/**
 * Parse a `.env`-style file into a plain object. Supports:
 *   - blank lines and `#` comments
 *   - single- or double-quoted values (quotes stripped)
 * Returns null if the file doesn't exist.
 */
export function parseEnvFile(envPath: string): Record<string, string> | null {
  let content: string
  try {
    content = fs.readFileSync(envPath, 'utf-8')
  }
  catch {
    return null
  }

  const env: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    const match = trimmed.match(ENV_LINE_RE)
    if (!match)
      continue
    const key = match[1].trim()
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))
      value = value.slice(1, -1)
    env[key] = value
  }
  return env
}

/**
 * Keys that were applied from `.env` into `process.env` (i.e. weren't already
 * set by the shell). Lets downstream code distinguish .env-sourced vars from
 * shell-exported ones for diagnostics.
 */
const appliedEnvKeys = new Set<string>()
let loadedEnvPath: string | null = null

export function getAppliedEnvKeys(): Set<string> {
  return appliedEnvKeys
}

export function getLoadedEnvPath(): string | null {
  return loadedEnvPath
}

/**
 * Load `.env` from the current working directory into `process.env`.
 * Existing `process.env` values win — shell exports take precedence over
 * `.env`, matching dotenv convention.
 *
 * Returns the keys that were actually applied (i.e. weren't already set).
 */
export function loadEnvFromCwd(): string[] {
  const envPath = path.join(process.cwd(), '.env')
  const parsed = parseEnvFile(envPath)
  if (!parsed)
    return []

  loadedEnvPath = envPath
  const applied: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
      applied.push(key)
      appliedEnvKeys.add(key)
    }
  }
  return applied
}
