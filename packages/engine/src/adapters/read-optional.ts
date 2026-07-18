// Disambiguates a *legitimately-absent* object from a *real read/IO failure*
// when calling `DataSource.read`.
//
// `DataSource.read` returns `Promise<Uint8Array>` and signals a missing key by
// *throwing* (filesystem: `ENOENT`; R2: `R2 object not found: …`). It never
// resolves to `undefined`. That makes a naive `.read(key).catch(() => undefined)`
// conflate two very different worlds:
//   - the object genuinely doesn't exist yet (first-run, never-written) — a
//     no-op the caller should treat as "absent", and
//   - the read *failed* (network blip, permission error, a corrupt object whose
//     decode threw) — a real failure that MUST surface, not be swallowed.
//
// `readOptional` keeps only the first case as `undefined` and re-raises
// everything else. It prefers a structural existence probe via `DataSource.head`
// when the backend exposes one (no error-message sniffing needed); otherwise it
// reads and inspects the thrown error, treating *only* a recognised not-found
// marker as absence and rethrowing any other failure.

import type { DataSource } from '../storage'

/**
 * True when `e` is the "object does not exist" signal a `DataSource.read`
 * raises for a missing key, across the backends we ship:
 * - filesystem: a `node:fs` `ENOENT` (`err.code === 'ENOENT'`),
 * - R2: `Error('R2 object not found: <key>')`,
 * - in-memory/test fakes: `Error('key not found: …')` / `Error('not found: …')`
 *   / `Error('missing key …')`,
 * - browser OPFS: a `DOMException`/error whose `name === 'NotFoundError'`.
 *
 * Anything else (a parse error, a 5xx, a permission error, an abort) is NOT a
 * missing key and must propagate.
 */
export function isMissingKeyError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null)
    return false
  const code = (e as { code?: unknown }).code
  if (code === 'ENOENT')
    return true
  const name = (e as { name?: unknown }).name
  if (name === 'NotFoundError')
    return true
  const message = (e as { message?: unknown }).message
  if (typeof message !== 'string')
    return false
  return /\bnot found\b|\bENOENT\b|\bmissing key\b/i.test(message)
}

/**
 * Read a key that may legitimately not exist yet. Resolves to the bytes, or to
 * `undefined` when the object is genuinely absent. A *real* read failure
 * (anything `isMissingKeyError` does not recognise) propagates, so callers can
 * no longer silently swallow it.
 *
 * Reads directly and recognizes only the shipped backends' explicit missing-key
 * errors. A HEAD-before-GET existence probe doubles remote round-trips for the
 * overwhelmingly common present-object path and still cannot eliminate the
 * delete race between the two operations.
 */
export async function readOptional(
  ds: DataSource,
  key: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  return await ds.read(key, undefined, signal).catch((e: unknown) => {
    if (isMissingKeyError(e))
      return undefined
    throw e
  })
}
