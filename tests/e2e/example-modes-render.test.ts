/**
 * Smoke: the example renders the layer-mode indicator for every advertised
 * mode. Pairs with `tests/example-modes.test.ts` — the unit test covers
 * `nuxt.config.ts` env → runtimeConfig resolution; this one boots the example
 * SSR server and asserts the layout's `[data-testid=analytics-mode]` block
 * actually surfaces the runtimeConfig value into the rendered DOM.
 *
 * Build runs once. The server is then bounced per mode with
 * `NUXT_PUBLIC_ANALYTICS_MODE=<mode>`, which Nuxt uses to override the
 * build-time `runtimeConfig.public.analytics.mode` at runtime.
 *
 * The overview route (/) calls `useGscSites()` which fans out to the API and
 * may 500 in a test environment without seeded auth. We inspect the raw
 * response body either way — the layout shell renders before the page body,
 * so `[data-testid=analytics-mode]` is present even on an SSR error page.
 */

import { fileURLToPath } from 'node:url'
import { fetch, setup, startServer, stopServer } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

const MODES = ['local', 'origin', 'consumer'] as const

describe('example layer-mode indicator', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../../examples/nuxt-dashboard', import.meta.url)),
    browser: false,
    server: true,
    dev: false,
  })

  it.each(MODES)('renders data-mode="%s" when NUXT_PUBLIC_ANALYTICS_MODE matches', async (mode) => {
    await stopServer()
    await startServer({ env: { NUXT_PUBLIC_ANALYTICS_MODE: mode } })
    const res = await fetch('/')
    const html = await res.text()
    expect(html).toContain('data-testid="analytics-mode"')
    expect(html).toContain(`data-mode="${mode}"`)
  })
})
