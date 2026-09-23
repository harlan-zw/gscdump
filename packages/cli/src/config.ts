import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SearchTypes } from 'gscdump/query'
import { z } from 'zod'
import { useCliRuntime } from './runtime'

export function setConfigDir(dir: string): void {
  useCliRuntime().configDir = dir
}

export function getConfigDir(): string {
  return useCliRuntime().configDir
}

const configSchema = z.strictObject({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  defaultSite: z.string().optional(),
  defaultFormat: z.enum(['json', 'csv']).optional(),
  dataDir: z.string().optional(),
  defaultLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  defaultSearchType: z.enum(SearchTypes).optional(),
  defaultDataState: z.enum(['all', 'final', 'hourly_all']).optional(),
  serviceAccountPath: z.string().optional(),
})

export type GscdumpConfig = z.infer<typeof configSchema>

// Earlier CLI versions wrote these keys. Drop them so old configs still load.
const RETIRED_KEYS = ['mode', 'cloudUrl', 'defaultPeriod', 'defaultDb']

function dropRetiredKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !RETIRED_KEYS.includes(key)))
}

function parseConfig(value: unknown): GscdumpConfig {
  const parsed = configSchema.safeParse(dropRetiredKeys(value))
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    throw new Error(`Invalid config at ${getConfigPath()}. ${issues.join('; ')}`)
  }
  return parsed.data
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.gscdump', 'data')
}

export function resolveDataDir(config: GscdumpConfig): string {
  return expandTilde(config.dataDir ?? defaultDataDir())
}

export interface ResolvedGscdumpConfig {
  config: GscdumpConfig
  dataDir: string
}

function expandTilde(p: string): string {
  if (p === '~')
    return os.homedir()
  if (p.startsWith('~/'))
    return path.join(os.homedir(), p.slice(2))
  return p
}

export async function loadConfig(): Promise<GscdumpConfig> {
  const data = await fs.readFile(getConfigPath(), 'utf-8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (data === undefined)
    return {}
  const value: unknown = await Promise.resolve().then(() => JSON.parse(data)).catch((cause: unknown) => {
    throw new Error(`Invalid JSON at ${getConfigPath()}. Fix this file before running the command.`, { cause })
  })
  return parseConfig(value)
}

export async function loadResolvedConfig(): Promise<ResolvedGscdumpConfig> {
  const config = await loadConfig()
  return { config, dataDir: resolveDataDir(config) }
}

export async function saveConfig(config: GscdumpConfig): Promise<void> {
  const parsed = parseConfig(config)
  const configDir = getConfigDir()
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(parsed, null, 2), { mode: 0o600 })
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json')
}
