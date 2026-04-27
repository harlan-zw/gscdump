import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    name: 'e2e',
    root: here,
    globals: true,
    reporters: 'default',
    include: ['*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
