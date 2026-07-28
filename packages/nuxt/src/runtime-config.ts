export type GscdumpDefaultEngine = 'auto' | 'client' | 'server'

export interface GscdumpAnalyticsRuntimeConfig {
  apiBase: string
  duckdbBundleBase: string
  duckdbThreadBundleBase: string
  timezone: string
  toastErrors: boolean
  defaultEngine: GscdumpDefaultEngine
}

export type GscdumpRuntimeEnvironment = Readonly<Record<string, string | undefined>>

const DEFAULT_ENGINES = new Set<GscdumpDefaultEngine>(['auto', 'client', 'server'])

function defaultEngine(value: string | undefined): GscdumpDefaultEngine {
  return value && DEFAULT_ENGINES.has(value as GscdumpDefaultEngine)
    ? value as GscdumpDefaultEngine
    : 'auto'
}

export function resolveGscdumpAnalyticsRuntimeConfig(
  configured: Partial<GscdumpAnalyticsRuntimeConfig> | undefined,
  environment: GscdumpRuntimeEnvironment,
): GscdumpAnalyticsRuntimeConfig {
  const defaults: GscdumpAnalyticsRuntimeConfig = {
    apiBase: environment.GSCDUMP_ANALYTICS_API_BASE ?? '',
    duckdbBundleBase: environment.GSCDUMP_DUCKDB_BUNDLE_BASE ?? '',
    duckdbThreadBundleBase: environment.GSCDUMP_DUCKDB_THREAD_BUNDLE_BASE ?? '',
    timezone: environment.GSCDUMP_ANALYTICS_TIMEZONE ?? '',
    toastErrors: environment.GSCDUMP_ANALYTICS_TOAST_ERRORS === 'true',
    defaultEngine: defaultEngine(environment.GSCDUMP_ANALYTICS_DEFAULT_ENGINE),
  }

  return {
    apiBase: configured?.apiBase ?? defaults.apiBase,
    duckdbBundleBase: configured?.duckdbBundleBase ?? defaults.duckdbBundleBase,
    duckdbThreadBundleBase: configured?.duckdbThreadBundleBase ?? defaults.duckdbThreadBundleBase,
    timezone: configured?.timezone ?? defaults.timezone,
    toastErrors: configured?.toastErrors ?? defaults.toastErrors,
    defaultEngine: configured?.defaultEngine ?? defaults.defaultEngine,
  }
}
