import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Treat browser-oriented tests as if they're running in a client bundle.
  // Server-side codepaths are covered in their package suites.
  define: {
    'import.meta.client': 'true',
    'import.meta.dev': 'true',
  },
  test: {
    globals: true,
    // Bound concurrent DuckDB instances on shared CI runners.
    maxWorkers: 4,
    // DuckDB WASM cold starts can exceed the default five-second timeout.
    testTimeout: 30_000,
    // `*.workers.test.ts` run in a real workerd runtime via the Cloudflare
    // pool — see `packages/cloudflare/vitest.workers.config.ts` (`pnpm
    // test:workers`). They can't run in this node project.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', '**/*.workers.test.ts', '**/*.browser.test.ts'],
  },
})
