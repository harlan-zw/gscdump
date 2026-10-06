import type { NuxtModule } from '@nuxt/schema'
import type { GscdumpDevframeOptions } from './index'
import { addVitePlugin, defineNuxtModule } from '@nuxt/kit'
import { gscdump } from './vite'

export interface ModuleOptions extends GscdumpDevframeOptions {
  /** Set false to skip the Search Console dock. */
  enabled?: boolean
}

declare module '@nuxt/schema' {
  interface NuxtConfig {
    gscdump?: Partial<ModuleOptions>
  }
  interface NuxtOptions {
    gscdump: ModuleOptions
  }
}

/** Mount the Search Console dock in Nuxt DevTools during development. */
const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@gscdump/devframe/nuxt',
    configKey: 'gscdump',
    compatibility: { nuxt: '^4.5.0' },
  },
  defaults: { enabled: true },
  setup({ enabled, ...options }, nuxt) {
    const devtools = nuxt.options.devtools
    if (!enabled || !nuxt.options.dev || devtools === false || (typeof devtools === 'object' && devtools.enabled === false))
      return

    addVitePlugin(() => gscdump(options))
  },
})

export default module
