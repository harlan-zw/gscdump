import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    reporters: 'dot',
    include: ['packages/*/test/**/*.test.ts', 'packages/*/e2e/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/real-credentials.test.ts',
    ],
  },
})
