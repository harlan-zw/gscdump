import process from 'node:process'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// Runs the OPFS attach lifecycle against a REAL browser Origin Private File
// System (chromium via Playwright), not the in-memory OPFS fake the node tests
// use. This is the only place the sync-access-handle exclusivity invariant —
// the root cause behind the registry rewrite — is exercised against the real
// platform primitive.
//
// Separate config (`pnpm test:browser`) so the default node run is unaffected;
// the root config excludes `*.browser.test.ts`.
//
// These are SLOW real-runtime suites (chromium boot, real OPFS, real DuckDB-WASM
// in the e2e). They are OPT-IN: only collected when `GSCDUMP_E2E` is set. The
// `test:browser` script sets it; any other invocation passes with no tests, so
// they never run by default (locally or in CI).
const e2e = Boolean(process.env.GSCDUMP_E2E)

export default defineConfig({
  // Pre-bundle the heavy deps the real-DuckDB e2e pulls in, so Vite doesn't
  // discover + re-optimize them mid-run (which reloads the page and fails the
  // in-flight dynamic import of @duckdb/duckdb-wasm).
  optimizeDeps: {
    include: [
      '@duckdb/duckdb-wasm',
      'drizzle-orm',
      'drizzle-orm/pg-core',
      // Transitive deps of @gscdump/engine the e2e pulls in — pre-bundle via the
      // parent specifier so Vite doesn't discover + reload them mid-run.
      '@gscdump/engine > hyparquet',
      '@gscdump/engine > hyparquet-writer',
    ],
  },
  test: {
    include: e2e ? ['test/**/*.browser.test.ts'] : [],
    passWithNoTests: true,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
})
