import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@gscdump/db',
    globals: true,
    reporters: 'dot',
    setupFiles: ['../../vitest.setup.ts'],
  },
})
