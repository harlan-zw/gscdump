/**
 * Tests the OPFS sync-access-handle lifecycle in pure node — no browser, no
 * real DuckDB. The fake backend models the one OPFS invariant that matters: a
 * backing file allows at most ONE live sync access handle, so opening a second
 * registration for a name that is already live throws the exact error DuckDB's
 * `BROWSER_FSACCESS` surfaces. The registry's job is to make sure that never
 * happens (dedup) and that handles are actually released (reference counting).
 */

import { describe, expect, it, vi } from 'vitest'
import { createOpfsHandleRegistry } from '../src/opfs-registry'

/**
 * Fake backend enforcing OPFS exclusivity. `register` throws the access-handle
 * conflict if a name is already live; `drop` releases it. Records call counts.
 */
function makeExclusivityBackend() {
  const live = new Set<string>()
  const register = vi.fn(async (name: string) => {
    if (live.has(name)) {
      const err = new Error(`Access Handles cannot be created if there is another open Access Handle or Writable stream (${name})`)
      err.name = 'InvalidStateError'
      throw err
    }
    live.add(name)
  })
  const drop = vi.fn(async (name: string) => {
    live.delete(name)
  })
  return { backend: { register, drop }, live, register, drop }
}

describe('createOpfsHandleRegistry', () => {
  it('registers a name once and opens its handle once', async () => {
    const { backend, register } = makeExclusivityBackend()
    const registry = createOpfsHandleRegistry(backend)
    const openHandle = vi.fn(async () => ({ name: 'h' }))

    await registry.acquire('pages_0', openHandle)

    expect(register).toHaveBeenCalledOnce()
    expect(openHandle).toHaveBeenCalledOnce()
    expect(registry.refs('pages_0')).toBe(1)
    expect(registry.size()).toBe(1)
  })

  it('deduplicates a second consumer of the same file — no second sync handle', async () => {
    // This is the core regression: two consumers sharing one DB (home fanout +
    // per-site analyzer) attach the same OPFS file. Without dedup the second
    // register would throw the exclusivity error. With it, the handle is reused.
    const { backend, register, drop } = makeExclusivityBackend()
    const registry = createOpfsHandleRegistry(backend)

    await registry.acquire('dates_0', () => ({ h: 1 }))
    await registry.acquire('dates_0', () => ({ h: 2 }))

    expect(register).toHaveBeenCalledOnce()
    expect(registry.refs('dates_0')).toBe(2)

    // First consumer detaches: file is still held by the second, must NOT drop.
    await registry.release(['dates_0'])
    expect(drop).not.toHaveBeenCalled()
    expect(registry.refs('dates_0')).toBe(1)

    // Last consumer detaches: now the sync access handle is released.
    await registry.release(['dates_0'])
    expect(drop).toHaveBeenCalledExactlyOnceWith('dates_0')
    expect(registry.size()).toBe(0)
  })

  it('proves the conflict the registry prevents: raw double-register throws', async () => {
    // Sanity check on the fake — registering the same name twice WITHOUT the
    // registry's dedup is exactly the OPFS access-handle exclusivity error.
    const { backend } = makeExclusivityBackend()
    await backend.register('pages_0', {})
    await expect(backend.register('pages_0', {})).rejects.toThrow(/Access Handle/)
  })

  it('releases the handle so a later acquire can re-register (fixes the leak)', async () => {
    // The old `detach` never dropped handles, so re-attaching after a content-
    // hash change left the old handle live forever. After a full release the
    // name is gone and the same name can be registered cleanly again.
    const { backend, register, drop, live } = makeExclusivityBackend()
    const registry = createOpfsHandleRegistry(backend)

    await registry.acquire('pages_0', () => ({}))
    await registry.release(['pages_0'])
    expect(live.size).toBe(0)
    expect(drop).toHaveBeenCalledOnce()

    // Re-acquire the same name — would throw the exclusivity error if the prior
    // handle had leaked. It doesn't, because release dropped it.
    await registry.acquire('pages_0', () => ({}))
    expect(register).toHaveBeenCalledTimes(2)
    expect(registry.refs('pages_0')).toBe(1)
  })

  it('does not register a phantom entry when the backend throws', async () => {
    const register = vi.fn(async () => {
      const err = new Error('Access Handle conflict')
      err.name = 'InvalidStateError'
      throw err
    })
    const drop = vi.fn(async () => {})
    const registry = createOpfsHandleRegistry({ register, drop })

    await expect(registry.acquire('x', () => ({}))).rejects.toThrow(/Access Handle/)
    // No entry recorded — a retry must be free to register again.
    expect(registry.refs('x')).toBe(0)
    expect(registry.size()).toBe(0)
  })

  it('ignores release of unknown names and never goes negative', async () => {
    const { backend, drop } = makeExclusivityBackend()
    const registry = createOpfsHandleRegistry(backend)

    await registry.release(['never-acquired'])
    expect(drop).not.toHaveBeenCalled()

    await registry.acquire('a', () => ({}))
    await registry.release(['a', 'a']) // double release of a 1-ref entry
    expect(registry.refs('a')).toBe(0)
    expect(drop).toHaveBeenCalledOnce()
  })

  it('dedups two CONCURRENT acquires of the same name (TOCTOU race)', async () => {
    // Two consumers sharing one DB (home fanout + per-site analyzer) can call
    // attachOpfsParquetTables concurrently, racing two acquire(sameName) calls.
    // The dedup check must survive the await between "is it registered?" and
    // "record the entry" — otherwise both register, the second hits the real
    // OPFS exclusivity error, and the refcount is wrong.
    const { backend, register, drop } = makeExclusivityBackend()
    // Widen the interleave window so both acquires pass the check before either
    // records its entry.
    const slowBackend = {
      register: async (name: string, handle: unknown) => {
        await new Promise(r => setTimeout(r, 5))
        return backend.register(name, handle)
      },
      drop: backend.drop,
    }
    const registry = createOpfsHandleRegistry(slowBackend)

    await Promise.all([
      registry.acquire('pages_0', () => ({ h: 1 })),
      registry.acquire('pages_0', () => ({ h: 2 })),
    ])

    // Exactly one real registration, refcount counts BOTH consumers.
    expect(register).toHaveBeenCalledOnce()
    expect(registry.refs('pages_0')).toBe(2)
    expect(registry.size()).toBe(1)

    // And both releases are needed to drop — no premature handle release.
    await registry.release(['pages_0'])
    expect(drop).not.toHaveBeenCalled()
    await registry.release(['pages_0'])
    expect(drop).toHaveBeenCalledOnce()
  })

  it('concurrent acquires where the first registration FAILS — a waiter retries', async () => {
    // If the in-flight registration fails, a concurrent waiter must not be
    // poisoned: it retries registering itself rather than inheriting the error.
    let attempt = 0
    const live = new Set<string>()
    const register = vi.fn(async (name: string) => {
      attempt++
      await new Promise(r => setTimeout(r, 5))
      if (attempt === 1) {
        const err = new Error('transient register failure')
        err.name = 'AbortError'
        throw err
      }
      live.add(name)
    })
    const drop = vi.fn(async (name: string) => {
      live.delete(name)
    })
    const registry = createOpfsHandleRegistry({ register, drop })

    const results = await Promise.allSettled([
      registry.acquire('x', () => ({})),
      registry.acquire('x', () => ({})),
    ])
    // One of the two rejects (the failed first registration); the other ends up
    // with a live, single-ref registration.
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(registry.refs('x')).toBe(1)
    expect(register).toHaveBeenCalledTimes(2)
  })

  it('swallows a failing drop but still forgets the entry', async () => {
    const register = vi.fn(async () => {})
    const drop = vi.fn(async () => {
      throw new Error('dropFile failed')
    })
    const registry = createOpfsHandleRegistry({ register, drop })

    await registry.acquire('a', () => ({}))
    await expect(registry.release(['a'])).resolves.toBeUndefined()
    expect(registry.size()).toBe(0)
  })

  it('refcounts views: drop only fires on the last release', async () => {
    const { backend } = makeExclusivityBackend()
    const registry = createOpfsHandleRegistry(backend)
    const drop = vi.fn(async () => {})

    registry.acquireView('main.dates')
    registry.acquireView('main.dates')
    expect(registry.viewRefs('main.dates')).toBe(2)

    await registry.releaseView('main.dates', drop)
    expect(drop).not.toHaveBeenCalled()
    expect(registry.viewRefs('main.dates')).toBe(1)

    await registry.releaseView('main.dates', drop)
    expect(drop).toHaveBeenCalledOnce()
    expect(registry.viewRefs('main.dates')).toBe(0)
  })

  it('tracks view signatures and rejects a conflicting active view', async () => {
    const { backend } = makeExclusivityBackend()
    const registry = createOpfsHandleRegistry(backend)

    registry.acquireView('main.dates', 'hash-a')
    registry.acquireView('main.dates', 'hash-a')

    expect(registry.viewRefs('main.dates')).toBe(2)
    expect(registry.viewSignature('main.dates')).toBe('hash-a')
    expect(() => registry.acquireView('main.dates', 'hash-b')).toThrow(/different signature/)
  })

  it('releaseView of an unknown key still runs drop (best-effort cleanup)', async () => {
    const { backend } = makeExclusivityBackend()
    const registry = createOpfsHandleRegistry(backend)
    const drop = vi.fn(async () => {})
    await registry.releaseView('main.orphan', drop)
    expect(drop).toHaveBeenCalledOnce()
  })
})
