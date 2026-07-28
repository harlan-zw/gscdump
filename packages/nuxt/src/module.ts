import type { NuxtModule } from '@nuxt/schema'
import type { GscdumpAnalyticsRuntimeConfig } from './runtime-config'
import process from 'node:process'
import { addPluginTemplate, defineNuxtModule } from '@nuxt/kit'
import { resolveGscdumpAnalyticsRuntimeConfig } from './runtime-config'

export interface GscdumpNuxtModuleOptions {
  /**
   * Nuxt-resolvable module exporting an analyzer array as `ANALYZERS` or
   * `default`.
   */
  analyzers?: string
}

declare module '@nuxt/schema' {
  interface NuxtConfig {
    gscdumpAnalytics?: GscdumpNuxtModuleOptions
  }

  interface NuxtOptions {
    gscdumpAnalytics: GscdumpNuxtModuleOptions
  }

  interface PublicRuntimeConfig {
    analytics: GscdumpAnalyticsRuntimeConfig
  }
}

const gscdumpNuxtModule: NuxtModule<GscdumpNuxtModuleOptions> = defineNuxtModule<GscdumpNuxtModuleOptions>({
  meta: {
    name: '@gscdump/nuxt',
    configKey: 'gscdumpAnalytics',
    compatibility: { nuxt: '>=4.0.0' },
  },
  defaults: {},
  setup(options, nuxt) {
    nuxt.options.runtimeConfig.public.analytics = resolveGscdumpAnalyticsRuntimeConfig(
      nuxt.options.runtimeConfig.public.analytics as Partial<GscdumpAnalyticsRuntimeConfig> | undefined,
      process.env,
    )

    if (!options.analyzers)
      return

    addPluginTemplate({
      filename: 'gscdump-analyzers.plugin.mjs',
      getContents: () => [
        `import { defineNuxtPlugin } from '#app'`,
        `import * as registry from ${JSON.stringify(options.analyzers)}`,
        `const analyzers = registry.ANALYZERS ?? registry.default`,
        `if (!Array.isArray(analyzers))`,
        `  throw new TypeError('gscdump analyzer registry must export an array')`,
        `export default defineNuxtPlugin(() => ({`,
        `  provide: { gscAnalyzers: analyzers },`,
        `}))`,
        ``,
      ].join('\n'),
    })
  },
})

export default gscdumpNuxtModule

export type {
  GscdumpAnalyticsRuntimeConfig,
  GscdumpDefaultEngine,
  GscdumpRuntimeEnvironment,
} from './runtime-config'
export { resolveGscdumpAnalyticsRuntimeConfig } from './runtime-config'
