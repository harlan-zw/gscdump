// Minimal UI fixture for `examples/nuxt-dashboard`.

import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import { dirname, resolve as resolvePath } from 'pathe'

const __here = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  modules: ['@nuxt/ui', 'nuxt-use-query'],
  imports: {
    dirs: [
      resolvePath(__here, 'app/composables'),
      resolvePath(__here, 'app/utils'),
    ],
  },
  components: [
    { path: resolvePath(__here, 'app/components'), prefix: '', global: true },
  ],
  runtimeConfig: {
    public: {
      analytics: {
        apiBase: '',
        duckdbBundleBase: '',
        timezone: '',
        toastErrors: false,
        defaultEngine: 'auto',
        mode: 'local',
      },
    },
  },
})
