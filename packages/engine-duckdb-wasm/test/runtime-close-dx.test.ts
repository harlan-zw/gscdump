import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserAnalysisRuntime } from '../src'

describe('browser runtime cleanup', () => {
  it('terminates its owned worker when the connection cannot close', async () => {
    const failure = new Error('connection close failed')
    const terminate = vi.fn(async () => {})
    const runtime = createBrowserAnalysisRuntime({
      db: { terminate } as unknown as AsyncDuckDB,
      conn: { close: async () => { throw failure } } as unknown as AsyncDuckDBConnection,
    })
    await expect(runtime.close()).rejects.toBe(failure)
    expect(terminate).toHaveBeenCalledOnce()
  })
})
