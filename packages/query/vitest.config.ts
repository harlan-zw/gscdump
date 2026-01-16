import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@gscdump/query',
    globals: true,
    reporters: 'dot',
  },
})
