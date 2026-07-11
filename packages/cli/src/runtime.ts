import type { ConsolaInstance } from 'consola'
import { AsyncLocalStorage } from 'node:async_hooks'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createConsola } from 'consola'

export type CliEnvironmentSource = Record<string, string | undefined>

export interface CliRuntime {
  activeProfileOverride: string | null
  colorEnabled: boolean
  configDir: string
  configDirOverridden: boolean
  environment: CliEnvironmentSource
  logger: ConsolaInstance
  quiet: boolean
  rawArgs: string[]
}

export interface CreateCliRuntimeOptions {
  configDir?: string
  environment?: CliEnvironmentSource
  rawArgs?: readonly string[]
  stderr?: NodeJS.WriteStream
}

const runtimeStorage = new AsyncLocalStorage<CliRuntime>()
let fallbackRuntime: CliRuntime | undefined

export function createCliRuntime(opts: CreateCliRuntimeOptions = {}): CliRuntime {
  const stderr = opts.stderr ?? process.stderr
  const baseLogger = createConsola({ stdout: stderr, stderr })
  return {
    activeProfileOverride: null,
    colorEnabled: true,
    configDir: opts.configDir ?? path.join(os.homedir(), '.config', 'gscdump'),
    configDirOverridden: false,
    environment: opts.environment ?? process.env,
    logger: baseLogger.withTag('gscdump'),
    quiet: false,
    rawArgs: [...(opts.rawArgs ?? process.argv.slice(2))],
  }
}

export function useCliRuntime(): CliRuntime {
  const active = runtimeStorage.getStore()
  if (active)
    return active
  fallbackRuntime ??= createCliRuntime()
  return fallbackRuntime
}

export function runWithCliRuntime<T>(runtime: CliRuntime, run: () => T): T {
  return runtimeStorage.run(runtime, run)
}
