import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    reporters: 'dot',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/real-credentials.test.ts',
    ],
  },
})
