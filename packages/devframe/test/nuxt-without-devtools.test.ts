import type { Nuxt } from '@nuxt/schema'
import module from '@gscdump/devframe/nuxt'
import { runWithNuxtContext } from '@nuxt/kit'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@vitejs/devtools-kit/node', () => {
  throw new Error('DevTools kit is not installed')
})

async function configure(options: { dev: boolean, devtools: boolean | { enabled: boolean }, enabled?: boolean }) {
  const config = { plugins: [{ name: 'existing-plugin' }] }
  const callbacks: Array<(event: { config: typeof config }) => Promise<void>> = []
  const nuxt = {
    _version: '4.5.2',
    options: { dev: options.dev, devtools: options.devtools, gscdump: { enabled: options.enabled }, experimental: {} },
    callHook: async () => {},
    hook(name: string, callback: (event: { config: typeof config }) => Promise<void>) {
      if (name === 'vite:extend')
        callbacks.push(callback)
    },
  } as unknown as Nuxt
  await runWithNuxtContext(nuxt, () => module({}, nuxt))
  for (const callback of callbacks)
    await callback({ config })
  return config.plugins
}

describe('nuxt without the optional DevTools kit', () => {
  it.each([
    { dev: false, devtools: true },
    { dev: true, devtools: true, enabled: false },
    { dev: true, devtools: false },
    { dev: true, devtools: { enabled: false } },
  ])('keeps existing plugins when the dock is skipped for %j', async (options) => {
    expect(await configure(options)).toEqual([{ name: 'existing-plugin' }])
  })
})
