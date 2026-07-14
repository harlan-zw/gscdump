import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

export default defineProject({
  resolve: {
    alias: {
      '@gscdump/contracts/v1': fileURLToPath(new URL('./src/v1/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@gscdump/contracts',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
  },
})
