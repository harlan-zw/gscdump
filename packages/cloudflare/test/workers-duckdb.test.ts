import { describe, expect, it } from 'vitest'
import { DuckDBServiceTimeoutError, withDuckDBDeadline } from '../src/workers-duckdb'

describe('withDuckDBDeadline', () => {
  it('resolves when the op finishes before the deadline', async () => {
    const result = await withDuckDBDeadline(Promise.resolve('ok'), 1000)
    expect(result).toBe('ok')
  })

  it('rejects with a typed timeout error when the op stalls past the deadline', async () => {
    // A never-resolving op stands in for a hung DUCKDB_SVC RPC.
    const stalled = new Promise<string>(() => {})
    await expect(withDuckDBDeadline(stalled, 20)).rejects.toBeInstanceOf(DuckDBServiceTimeoutError)
  })

  it('surfaces the timeout fast — never rides the wall ceiling', async () => {
    const stalled = new Promise<string>(() => {})
    const started = Date.now()
    await withDuckDBDeadline(stalled, 30).catch(() => {})
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('propagates the op rejection unchanged when it fails before the deadline', async () => {
    const boom = new Error('duckdb binder error')
    await expect(withDuckDBDeadline(Promise.reject(boom), 1000)).rejects.toBe(boom)
  })

  it('rejects immediately when the caller signal is already aborted', async () => {
    const stalled = new Promise<string>(() => {})
    await expect(withDuckDBDeadline(stalled, 1000, AbortSignal.abort())).rejects.toBeDefined()
  })

  it('rejects when the caller signal aborts mid-flight', async () => {
    const stalled = new Promise<string>(() => {})
    const ctrl = new AbortController()
    const race = withDuckDBDeadline(stalled, 5000, ctrl.signal)
    ctrl.abort()
    await expect(race).rejects.toBeDefined()
  })
})
