import type { DuckDBFactory, DuckDBHandle, Row } from '@gscdump/engine'

// Module-scope singleton. First request in an isolate pays init cost; subsequent
// requests reuse the same handle. Workers isolates are short-lived, so expect
// re-init a few times per minute in production.
//
// NOTE (dogfooding TODO): the @duckdb/duckdb-wasm browser bundle is not yet
// wired in. Calling writeDay/query on the engine will fail with the error
// below. This is intentional — the dual-write hook is gated behind
// migrationPhase !== 'd1', so no users are affected until we flip someone.
//
// Before Layer 5 (dogfood), replace the `initHandle()` body with a concrete
// instantiation of `@duckdb/duckdb-wasm` (browser-blocking or AsyncDuckDB
// built without a web-worker URL). See duckdb-node.ts in the gscdump package
// for the Node-blocking reference implementation.

let handle: Promise<DuckDBHandle> | null = null

async function initHandle(): Promise<DuckDBHandle> {
  throw new Error(
    'DuckDB-WASM handle not wired for Cloudflare Workers yet. '
    + 'Complete server/internal/duckdb-wasm-handle.ts before enabling '
    + 'dual-write (user.migration_phase != \'d1\').',
  )
}

export function getWasmDuckDBFactory(): DuckDBFactory {
  return {
    getDuckDB(): Promise<DuckDBHandle> {
      if (!handle)
        handle = initHandle()
      return handle
    },
  }
}

export function resetWasmDuckDB(): void {
  handle = null
}

// Helper typed re-export so other files in this folder don't need to import
// directly from @gscdump/engine just for the Row type.
export type { Row }
