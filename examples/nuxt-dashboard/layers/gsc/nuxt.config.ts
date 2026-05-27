// Minimal Nuxt layer that backs `examples/nuxt-dashboard`. The real layer
// now lives at nuxtseo.com; this stub only provides typed composables and
// placeholder components so the example builds.
// TODO: port from nuxtseo.com

import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import { dirname, resolve as resolvePath } from 'pathe'

const __here = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  modules: ['@nuxt/ui', 'nuxt-use-query', resolvePath(__here, 'module.ts')],
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
