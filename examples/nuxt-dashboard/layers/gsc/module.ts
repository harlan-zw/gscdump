// Minimal module that consumes the `gscdumpAnalytics` config key so the
// example dashboard can pass `analyzers: '~/gscAnalyzers'` without Nuxt
// complaining. The real layer generates a build-time plugin from this path;
// the stub takes the path string and adds it as a Nuxt plugin so analyzers
// land on `$gscAnalyzers`.
// TODO: port from nuxtseo.com

import { addPlugin, addTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'

export interface GscdumpAnalyticsModuleOptions {
  analyzers?: string
}

declare module '@nuxt/schema' {
  interface NuxtConfig {
    gscdumpAnalytics?: GscdumpAnalyticsModuleOptions
  }
  interface NuxtOptions {
    gscdumpAnalytics?: GscdumpAnalyticsModuleOptions
  }
}

export default defineNuxtModule<GscdumpAnalyticsModuleOptions>({
  meta: {
    name: '@gscdump/nuxt',
    configKey: 'gscdumpAnalytics',
  },
  defaults: {},
  setup(options) {
    const resolver = createResolver(import.meta.url)
    if (options.analyzers) {
      const tpl = addTemplate({
        filename: 'gscdump-analyzers.mjs',
        write: true,
        getContents: () => `
import * as mod from '${options.analyzers}'
import { defineNuxtPlugin } from '#app'
const analyzers = mod.ANALYZERS ?? mod.default ?? (Array.isArray(mod) ? mod : [])
export default defineNuxtPlugin(() => ({
  provide: { gscAnalyzers: analyzers },
}))
`,
      })
      addPlugin({ src: tpl.dst })
    }
    else {
      addPlugin(resolver.resolve('./app/plugins/gsc-analyzers.client'))
    }
  },
})
