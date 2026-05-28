import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Treat tests as if they're running in a Nuxt client bundle. The
  // `@gscdump/nuxt` package gates its auth-pending defer + dev assertions on
  // these. Server-side codepaths aren't covered here anyway — they're tested
  // in `@gscdump/engine` / `@gscdump/analysis` instead.
  define: {
    'import.meta.client': 'true',
    'import.meta.dev': 'true',
  },
  test: {
    globals: true,
    // `*.workers.test.ts` run in a real workerd runtime via the Cloudflare
    // pool — see `packages/cloudflare/vitest.workers.config.ts` (`pnpm
    // test:workers`). They can't run in this node project.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', '**/*.workers.test.ts', '**/*.browser.test.ts'],
  },
})
