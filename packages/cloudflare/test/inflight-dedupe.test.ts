import { describe, expect, it, vi } from 'vitest'
import { createInflightDedupe, getHostedR2QueryKey } from '../src/inflight-dedupe'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createInflightDedupe', () => {
  it('coalesces concurrent identical ops onto a single underlying call', async () => {
    const d = createInflightDedupe<number>()
    const gate = deferred<number>()
    const run = vi.fn(() => gate.promise)

    const a = d.dedupe('k', run)
    const b = d.dedupe('k', run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(d.has('k')).toBe(true)

    gate.resolve(42)
    expect(await a).toBe(42)
    expect(await b).toBe(42)
  })

  it('deletes the entry after success so a later call re-runs', async () => {
    const d = createInflightDedupe<number>()
    const run = vi.fn(async () => 1)
    await d.dedupe('k', run)
    expect(d.has('k')).toBe(false)
    await d.dedupe('k', run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('deletes the entry after rejection and fans the rejection out to all callers', async () => {
    const d = createInflightDedupe<number>()
    const gate = deferred<number>()
    const run = vi.fn(() => gate.promise)

    const a = d.dedupe('k', run)
    const b = d.dedupe('k', run)
    expect(run).toHaveBeenCalledTimes(1)

    const err = new Error('boom')
    gate.reject(err)
    await expect(a).rejects.toBe(err)
    await expect(b).rejects.toBe(err)
    expect(d.has('k')).toBe(false)
  })

  it('does not delete a newer entry when an older same-key promise settles', async () => {
    const d = createInflightDedupe<number>()
    const g1 = deferred<number>()
    const p1 = d.dedupe('k', () => g1.promise)
    g1.resolve(1)
    await p1
    // entry cleared; start a fresh in-flight op under the same key
    const g2 = deferred<number>()
    const p2 = d.dedupe('k', () => g2.promise)
    expect(d.has('k')).toBe(true)
    g2.resolve(2)
    expect(await p2).toBe(2)
  })

  it('clear() empties the map', async () => {
    const d = createInflightDedupe<number>()
    d.dedupe('k', () => deferred<number>().promise)
    expect(d.has('k')).toBe(true)
    d.clear()
    expect(d.has('k')).toBe(false)
  })
})

describe('getHostedR2QueryKey', () => {
  const base = { userId: 'u1', siteId: 's1' }

  it('is stable: same state → same key, regardless of object key order', () => {
    const k1 = getHostedR2QueryKey({ ...base, state: { a: 1, b: 2 } })
    const k2 = getHostedR2QueryKey({ ...base, state: { b: 2, a: 1 } })
    expect(k1).toBe(k2)
  })

  it('is distinct for different state', () => {
    const k1 = getHostedR2QueryKey({ ...base, state: { a: 1 } })
    const k2 = getHostedR2QueryKey({ ...base, state: { a: 2 } })
    expect(k1).not.toBe(k2)
  })

  it('distinguishes {a:undefined} from {} (no undefined-vs-missing ambiguity)', () => {
    const k1 = getHostedR2QueryKey({ ...base, state: { a: undefined } })
    const k2 = getHostedR2QueryKey({ ...base, state: {} })
    expect(k1).not.toBe(k2)
  })

  it('does not collide on the former 32-bit hash collision pairs (aaa vs abB)', () => {
    // 'aaa' and 'abB' hash to the same 32-bit value under the old djb2 variant.
    const k1 = getHostedR2QueryKey({ ...base, state: 'aaa' })
    const k2 = getHostedR2QueryKey({ ...base, state: 'abB' })
    expect(k1).not.toBe(k2)
  })

  it('cannot be forged across segments via a colon in a field', () => {
    // userId 'a' + siteId 'b:c' must not equal userId 'a:b' + siteId 'c'.
    const k1 = getHostedR2QueryKey({ userId: 'a', siteId: 'b:c', state: null })
    const k2 = getHostedR2QueryKey({ userId: 'a:b', siteId: 'c', state: null })
    expect(k1).not.toBe(k2)
  })

  it('distinguishes a present falsy comparison from an absent one', () => {
    const present = getHostedR2QueryKey({ ...base, state: null, comparison: 0 })
    const absent = getHostedR2QueryKey({ ...base, state: null })
    expect(present).not.toBe(absent)
  })

  it('reflects comparison and comparisonFilter in the key', () => {
    const k1 = getHostedR2QueryKey({ ...base, state: null, comparisonFilter: 'x' })
    const k2 = getHostedR2QueryKey({ ...base, state: null, comparisonFilter: 'y' })
    expect(k1).not.toBe(k2)
  })
})
