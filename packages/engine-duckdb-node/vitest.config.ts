import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'engine-duckdb-node',
    globals: true,
    reporters: 'dot',
    setupFiles: ['../../vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
})
