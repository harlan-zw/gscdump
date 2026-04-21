import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'engine-wasm',
    globals: true,
    reporters: 'dot',
    setupFiles: ['../../vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
    },
  },
})
