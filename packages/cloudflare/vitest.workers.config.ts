import process from 'node:process'
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Runs the R2-binding tests inside a real workerd runtime (miniflare-backed R2)
// instead of the hand-rolled in-memory fakes the node tests use. This is the
// only place the manifest CAS loop and DataSource byte/range/list semantics run
// against R2's real conditional-put + etag behaviour.
//
// Kept as a SEPARATE config (`pnpm test:workers`) so the default node `pnpm
// test` run is unaffected; the root config excludes `*.workers.test.ts`.
//
// vitest-pool-workers v0.16 (vitest 4) replaced `defineWorkersConfig` with the
// programmatic `cloudflareTest` plugin + `cloudflarePool` pool initializer.
const poolOptions = {
  miniflare: {
    compatibilityDate: '2024-12-01',
    // In-memory R2 bucket exposed as `env.TEST_BUCKET` via `cloudflare:test`.
    r2Buckets: ['TEST_BUCKET'],
  },
}

// SLOW real-runtime suite (boots workerd/miniflare; the adversarial contention
// + >1000-key tests take tens of seconds). OPT-IN only: collected when
// `GSCDUMP_E2E` is set. The `test:workers` script sets it; any other invocation
// passes with no tests, so it never runs by default (locally or in CI).
const e2e = Boolean(process.env.GSCDUMP_E2E)

export default defineConfig({
  plugins: [cloudflareTest(poolOptions)],
  test: {
    include: e2e ? ['test/**/*.workers.test.ts'] : [],
    passWithNoTests: true,
    pool: cloudflarePool(poolOptions),
  },
})
