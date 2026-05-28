import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'engine-duckdb-wasm',
    globals: true,
    reporters: 'dot',
    setupFiles: ['../../vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Browser-only OPFS suite — runs via `pnpm test:browser` (chromium).
      '**/*.browser.test.ts',
    ],
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
    },
  },
})
