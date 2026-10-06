import type { Nuxt } from '@nuxt/schema'
import { runWithNuxtContext } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'
import module from '../src/nuxt'

async function configure(options: { dev: boolean, devtools: boolean | { enabled: boolean }, enabled?: boolean }) {
  const callbacks: Array<(event: any) => Promise<void>> = []
  const nuxt = {
    _version: '4.5.2',
    options: { dev: options.dev, devtools: options.devtools, gscdump: { enabled: options.enabled }, experimental: {} },
    callHook: async () => {},
    hook(name: string, callback: (event: any) => Promise<void>) {
      if (name === 'vite:extend')
        callbacks.push(callback)
    },
  } as unknown as Nuxt
  await runWithNuxtContext(nuxt, () => module({}, nuxt))
  const config = { plugins: [{ name: 'existing-plugin' }] }
  for (const callback of callbacks)
    await callback({ config })
  return config.plugins.map(plugin => plugin.name)
}

describe('nuxt Search Console module', () => {
  it('adds the dock to a development server without removing existing plugins', async () => {
    expect(await configure({ dev: true, devtools: true })).toEqual(['existing-plugin', 'devframe:gscdump'])
  })

  it.each([
    { dev: false, devtools: true },
    { dev: true, devtools: true, enabled: false },
    { dev: true, devtools: false },
    { dev: true, devtools: { enabled: false } },
  ])('skips the dock for %j', async (options) => {
    expect(await configure(options)).toEqual(['existing-plugin'])
  })
})
