/**
 * OPFS sync-access-handle lifecycle, modelled as a pure, reference-counted
 * registry so the exclusivity invariant is testable without a browser.
 *
 * The hard OPFS rule: a backing file allows at most ONE live sync access
 * handle. DuckDB-WASM's `BROWSER_FSACCESS` opens that handle lazily on first
 * read. Two problems followed from the old boolean-`Set` dedup:
 *
 *  1. Registration was deduped per `(db, name)` but NEVER released — `detach`
 *     dropped the view yet left the sync access handle open for the DB's
 *     lifetime. Re-attaching after a content-hash change registered a NEW name
 *     while the OLD handle stayed live, so handles accumulated until a read hit
 *     the exclusivity error.
 *  2. A boolean cannot tell when a shared file is safe to release. When two
 *     consumers share one DB (home fanout + per-site analyzer via
 *     `sharedGscDuckDBWasm`), the first `detach` must NOT yank a handle the
 *     second consumer still reads through.
 *
 * Reference counting solves both: `acquire` registers once and bumps a count;
 * `release` decrements and only calls `dropFile` (releasing the sync access
 * handle) when the last consumer lets go. The backend is injected so tests can
 * model OPFS exclusivity — a fake that throws when a second handle is opened on
 * a name that is already live.
 */

/**
 * The side of the registry that actually talks to DuckDB (or, in tests, a fake
 * that enforces single-live-handle-per-name). `register` opens/replaces the
 * file handle; `drop` releases it (and its OPFS sync access handle).
 */
export interface OpfsHandleBackend {
  register: (name: string, handle: unknown) => Promise<void>
  drop: (name: string) => Promise<void>
}

interface RegistryEntry {
  handle: unknown
  refs: number
}

interface ViewRegistryEntry {
  refs: number
  signature: string | undefined
}

export interface OpfsHandleRegistry {
  /**
   * Ensure `name` is registered with the backend exactly once, then increment
   * its reference count. `openHandle` is only invoked on the first acquire for
   * a name — subsequent acquires reuse the existing registration (dedup), which
   * is what prevents a second sync access handle on the same backing file.
   */
  acquire: (name: string, openHandle: () => Promise<unknown> | unknown) => Promise<void>
  /**
   * Decrement the reference count for each name; when a name reaches zero its
   * handle is dropped (releasing the OPFS sync access handle). Unknown names
   * are ignored so callers can release optimistically. Best-effort: a failing
   * `drop` is reported but still removes the entry so a later acquire can
   * re-register.
   */
  release: (names: readonly string[]) => Promise<void>
  /** Live (non-zero refcount) registration count. Diagnostics + tests. */
  size: () => number
  /** Current reference count for a name (0 when not registered). Tests. */
  refs: (name: string) => number
  /**
   * Increment the reference count for a DuckDB VIEW (keyed `schema.table`).
   * Views are created by the caller inline (the conflict-handling lives in the
   * attach loop), so this only tracks ownership — it does not create the view.
   * A view shared by two consumers on one DB must not be dropped until both
   * detach, otherwise the first detach breaks the second consumer's queries.
   */
  acquireView: (key: string, signature?: string) => void
  /**
   * Decrement a view's reference count; when it reaches zero, run `drop` (the
   * caller's `DROP VIEW IF EXISTS`). Unknown keys run `drop` (best-effort
   * cleanup for a view that was created but never acquired).
   */
  releaseView: (key: string, drop: () => Promise<void>) => Promise<void>
  /** Current reference count for a view key (0 when no consumer holds it). */
  viewRefs: (key: string) => number
  /** Signature of the live view definition, if this registry owns it. */
  viewSignature: (key: string) => string | undefined
}

export function createOpfsHandleRegistry(backend: OpfsHandleBackend): OpfsHandleRegistry {
  const entries = new Map<string, RegistryEntry>()
  // In-flight first-registrations, keyed by name. `acquire` does a check
  // (is it registered?) followed by awaits (open + register) before it records
  // the entry — so two CONCURRENT acquires of the same name would both pass the
  // check and double-register, tripping the real OPFS exclusivity error and
  // miscounting refs. This map serialises them: the first acquire claims the
  // slot synchronously (no await before the `set`), and concurrent acquires
  // await that registration instead of starting their own.
  const pending = new Map<string, Promise<void>>()

  function reportCleanupFailure(operation: string, error: unknown): void {
    console.warn(`[gscdump/engine-duckdb-wasm] ${operation} failed`, error)
  }

  async function acquire(name: string, openHandle: () => Promise<unknown> | unknown): Promise<void> {
    const existing = entries.get(name)
    if (existing) {
      existing.refs++
      return
    }
    const inflight = pending.get(name)
    if (inflight) {
      // Another acquire is registering this name. Wait for it, then just bump
      // the refcount. If it failed, retry as a fresh first-registrant.
      // The first registrant observes the rejection. This waiter treats it as
      // a retry signal and attempts a fresh registration below.
      await inflight.then(() => undefined, () => undefined)
      const settled = entries.get(name)
      if (settled) {
        settled.refs++
        return
      }
      return acquire(name, openHandle)
    }
    // We are the first registrant. Claim the slot synchronously (the IIFE runs
    // up to its first await, and `pending.set` happens with no intervening
    // await in this function) so a concurrent acquire sees the in-flight promise.
    const registration = (async () => {
      const handle = await openHandle()
      // Register before recording the entry: if the backend throws (e.g. the
      // real OPFS exclusivity error), we must NOT leave a phantom entry behind.
      await backend.register(name, handle)
      entries.set(name, { handle, refs: 1 })
    })()
    pending.set(name, registration)
    try {
      await registration
    }
    finally {
      pending.delete(name)
    }
  }

  async function release(names: readonly string[]): Promise<void> {
    for (const name of names) {
      const entry = entries.get(name)
      if (!entry)
        continue
      entry.refs--
      if (entry.refs > 0)
        continue
      entries.delete(name)
      await backend.drop(name).catch((error: unknown) => {
        reportCleanupFailure(`dropping OPFS handle ${name}`, error)
      })
    }
  }

  const viewRefs = new Map<string, ViewRegistryEntry>()

  function acquireView(key: string, signature?: string): void {
    const existing = viewRefs.get(key)
    if (existing) {
      if (existing.signature !== signature)
        throw new Error(`view ${key} is already attached with a different signature`)
      existing.refs++
      return
    }
    viewRefs.set(key, { refs: 1, signature })
  }

  async function releaseView(key: string, drop: () => Promise<void>): Promise<void> {
    const existing = viewRefs.get(key)
    const next = (existing?.refs ?? 0) - 1
    if (next > 0) {
      viewRefs.set(key, { refs: next, signature: existing?.signature })
      return
    }
    viewRefs.delete(key)
    await drop().catch((error: unknown) => {
      reportCleanupFailure(`dropping view ${key}`, error)
    })
  }

  return {
    acquire,
    release,
    size: () => entries.size,
    refs: name => entries.get(name)?.refs ?? 0,
    acquireView,
    releaseView,
    viewRefs: key => viewRefs.get(key)?.refs ?? 0,
    viewSignature: key => viewRefs.get(key)?.signature,
  }
}
