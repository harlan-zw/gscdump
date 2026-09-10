import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.workers.test.ts'],
    maxWorkers: 4,
    testTimeout: 30_000,
  },
})
