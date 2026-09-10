import type { OutputOptions } from './layout'
import process from 'node:process'
import { useCliRuntime } from '../runtime'

export function resolveOutputOptions(input: {
  columns?: number
  isTTY?: boolean
  environment: Record<string, string | undefined>
  noColor?: boolean
}): OutputOptions {
  const env = input.environment
  const dumb = env.TERM === 'dumb'
  return {
    columns: input.columns && input.columns > 0 ? Math.floor(input.columns) : 80,
    color: !dumb && !input.noColor && !env.NO_COLOR && env.FORCE_COLOR !== '0'
      && (Boolean(input.isTTY) || Boolean(env.FORCE_COLOR)),
    unicode: !dumb,
  }
}

export function terminalOutputOptions(toFile = false): OutputOptions {
  const runtime = useCliRuntime()
  const options = resolveOutputOptions({
    columns: toFile ? 80 : process.stdout.columns,
    isTTY: !toFile && process.stdout.isTTY,
    environment: runtime.environment,
    noColor: !runtime.colorEnabled || runtime.rawArgs.includes('--no-color'),
  })
  return toFile ? { ...options, color: false } : options
}
