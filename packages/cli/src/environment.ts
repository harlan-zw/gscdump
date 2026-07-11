import type { CliEnvironmentSource } from './runtime'
import { useCliRuntime } from './runtime'

export type { CliEnvironmentSource } from './runtime'

export interface CliEnvironment {
  accessToken?: string
  clientId?: string
  clientSecret?: string
  configDir?: string
  forceColor: boolean
  noColor: boolean
  profile?: string
  refreshToken?: string
  serviceAccountPath?: string
  values: CliEnvironmentSource
}

/**
 * Resolve every environment-controlled CLI option in one place. Callers may
 * pass an object in tests; production defaults to `process.env` at invocation
 * time, never at module import time.
 */
export function resolveCliEnvironment(values: CliEnvironmentSource = useCliRuntime().environment): CliEnvironment {
  return {
    accessToken: values.GSC_ACCESS_TOKEN || values.GOOGLE_ACCESS_TOKEN,
    clientId: values.GSC_CLIENT_ID || values.GOOGLE_CLIENT_ID,
    clientSecret: values.GSC_CLIENT_SECRET || values.GOOGLE_CLIENT_SECRET,
    configDir: values.GSCDUMP_CONFIG_DIR,
    forceColor: Boolean(values.FORCE_COLOR),
    noColor: Boolean(values.NO_COLOR),
    profile: values.GSCDUMP_PROFILE,
    refreshToken: values.GSC_REFRESH_TOKEN || values.GOOGLE_REFRESH_TOKEN,
    serviceAccountPath: values.GSC_SERVICE_ACCOUNT_JSON || values.GOOGLE_APPLICATION_CREDENTIALS,
    values,
  }
}

export function pickCliEnvironmentValue(
  names: readonly string[],
  values: CliEnvironmentSource = useCliRuntime().environment,
): { envVar: string, value: string } | null {
  for (const envVar of names) {
    const value = values[envVar]
    if (value)
      return { envVar, value }
  }
  return null
}

export function applyCliEnvironment(
  updates: CliEnvironmentSource,
  values: CliEnvironmentSource = useCliRuntime().environment,
): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined)
      delete values[key]
    else
      values[key] = value
  }
}
