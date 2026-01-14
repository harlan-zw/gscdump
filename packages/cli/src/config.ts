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
  mode?: 'cloud' | 'local'
  cloudUrl?: string
  clientId?: string
  clientSecret?: string
  defaultSite?: string
  defaultPeriod?: string
  defaultFormat?: 'json' | 'csv'
  defaultDb?: string
}

export const DEFAULT_CLOUD_URL = 'https://cloud.gscdump.com'

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
