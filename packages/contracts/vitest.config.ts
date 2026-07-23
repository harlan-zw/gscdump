import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

export default defineProject({
  resolve: {
    alias: {
      '@gscdump/contracts/v1/browser': fileURLToPath(new URL('./src/v1/browser.ts', import.meta.url)),
      '@gscdump/contracts/v1/http': fileURLToPath(new URL('./src/v1/http.ts', import.meta.url)),
      '@gscdump/contracts/v1/realtime': fileURLToPath(new URL('./src/v1/realtime.ts', import.meta.url)),
      '@gscdump/contracts/v1': fileURLToPath(new URL('./src/v1/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@gscdump/contracts',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
  },
})
