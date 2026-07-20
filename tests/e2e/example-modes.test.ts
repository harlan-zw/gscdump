/**
 * Layer contract: the example boots cleanly in each layer mode.
 *
 * Verifies that `examples/nuxt-dashboard/nuxt.config.ts` reads
 * `GSCDUMP_ANALYTICS_MODE`, validates it, and threads the resolved
 * `mode` + `apiBase` into the public runtime config. Acts as a fast,
 * deterministic gate for the layer 1.0 publish: any mode the layer
 * advertises must round-trip through the example without surprise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface PublicAnalytics {
  mode?: string
  apiBase?: string
}

interface NuxtConfigShape {
  runtimeConfig?: { public?: { analytics?: PublicAnalytics } }
}

vi.stubGlobal('defineNuxtConfig', <T>(input: T) => input)

async function loadConfig(): Promise<NuxtConfigShape> {
  vi.resetModules()
  const mod = await import('../../examples/nuxt-dashboard/nuxt.config.ts') as { default: NuxtConfigShape }
  return mod.default
}

describe('layer contract: example boots in every advertised mode', () => {
  let originalMode: string | undefined
  let originalApiBase: string | undefined

  beforeEach(() => {
    originalMode = process.env.GSCDUMP_ANALYTICS_MODE
    originalApiBase = process.env.GSCDUMP_ANALYTICS_API_BASE
  })

  afterEach(() => {
    if (originalMode === undefined)
      delete process.env.GSCDUMP_ANALYTICS_MODE
    else
      process.env.GSCDUMP_ANALYTICS_MODE = originalMode
    if (originalApiBase === undefined)
      delete process.env.GSCDUMP_ANALYTICS_API_BASE
    else
      process.env.GSCDUMP_ANALYTICS_API_BASE = originalApiBase
  })

  it('local mode: empty apiBase, no remote proxy', async () => {
    process.env.GSCDUMP_ANALYTICS_MODE = 'local'
    delete process.env.GSCDUMP_ANALYTICS_API_BASE
    const cfg = await loadConfig()
    expect(cfg.runtimeConfig?.public?.analytics?.mode).toBe('local')
    expect(cfg.runtimeConfig?.public?.analytics?.apiBase).toBe('')
  })

  it('origin mode: empty apiBase, same-origin server', async () => {
    process.env.GSCDUMP_ANALYTICS_MODE = 'origin'
    delete process.env.GSCDUMP_ANALYTICS_API_BASE
    const cfg = await loadConfig()
    expect(cfg.runtimeConfig?.public?.analytics?.mode).toBe('origin')
    expect(cfg.runtimeConfig?.public?.analytics?.apiBase).toBe('')
  })

  it('consumer mode: apiBase defaults to gscdump.com', async () => {
    process.env.GSCDUMP_ANALYTICS_MODE = 'consumer'
    delete process.env.GSCDUMP_ANALYTICS_API_BASE
    const cfg = await loadConfig()
    expect(cfg.runtimeConfig?.public?.analytics?.mode).toBe('consumer')
    expect(cfg.runtimeConfig?.public?.analytics?.apiBase).toBe('https://gscdump.com')
  })

  it('consumer mode: apiBase honors GSCDUMP_ANALYTICS_API_BASE override', async () => {
    process.env.GSCDUMP_ANALYTICS_MODE = 'consumer'
    process.env.GSCDUMP_ANALYTICS_API_BASE = 'https://staging.gscdump.com'
    const cfg = await loadConfig()
    expect(cfg.runtimeConfig?.public?.analytics?.apiBase).toBe('https://staging.gscdump.com')
  })

  it('rejects an unknown mode at config load', async () => {
    process.env.GSCDUMP_ANALYTICS_MODE = 'invalid'
    await expect(loadConfig()).rejects.toThrow(/GSCDUMP_ANALYTICS_MODE must be one of/)
  })

  it('default (env unset) resolves to local', async () => {
    delete process.env.GSCDUMP_ANALYTICS_MODE
    delete process.env.GSCDUMP_ANALYTICS_API_BASE
    const cfg = await loadConfig()
    expect(cfg.runtimeConfig?.public?.analytics?.mode).toBe('local')
  })
})
