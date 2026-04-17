import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let configDir = path.join(os.homedir(), '.config', 'gscdump')

export function setConfigDir(dir: string): void {
  configDir = dir
}

export function getConfigDir(): string {
  return configDir
}

export interface GscdumpConfig {
  clientId?: string
  clientSecret?: string
  defaultSite?: string
  defaultPeriod?: string
  defaultFormat?: 'json' | 'csv'
  defaultDb?: string
  dataDir?: string
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.gscdump', 'data')
}

export function resolveDataDir(config: GscdumpConfig): string {
  return expandTilde(config.dataDir ?? defaultDataDir())
}

function expandTilde(p: string): string {
  if (p === '~')
    return os.homedir()
  if (p.startsWith('~/'))
    return path.join(os.homedir(), p.slice(2))
  return p
}

export async function loadConfig(): Promise<GscdumpConfig> {
  return fs.readFile(path.join(configDir, 'config.json'), 'utf-8')
    .then(data => JSON.parse(data) as GscdumpConfig)
    .catch(() => ({}))
}

export async function saveConfig(config: GscdumpConfig): Promise<void> {
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function getConfigPath(): string {
  return path.join(configDir, 'config.json')
}
