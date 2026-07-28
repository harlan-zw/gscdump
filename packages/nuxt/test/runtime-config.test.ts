import { describe, expect, it } from 'vitest'
import { resolveGscdumpAnalyticsRuntimeConfig } from '../src/runtime-config'

describe('resolveGscdumpAnalyticsRuntimeConfig', () => {
  it('parses environment defaults once and preserves configured values', () => {
    expect(resolveGscdumpAnalyticsRuntimeConfig({
      apiBase: '/analytics',
      toastErrors: false,
    }, {
      GSCDUMP_ANALYTICS_API_BASE: 'https://ignored.test',
      GSCDUMP_ANALYTICS_TOAST_ERRORS: 'true',
      GSCDUMP_ANALYTICS_DEFAULT_ENGINE: 'client',
    })).toEqual({
      apiBase: '/analytics',
      duckdbBundleBase: '',
      duckdbThreadBundleBase: '',
      timezone: '',
      toastErrors: false,
      defaultEngine: 'client',
    })
  })

  it('rejects unknown engine values at the environment boundary', () => {
    expect(resolveGscdumpAnalyticsRuntimeConfig(undefined, {
      GSCDUMP_ANALYTICS_DEFAULT_ENGINE: 'remote',
    }).defaultEngine).toBe('auto')
  })
})
