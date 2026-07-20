// A no-dep `Either`/`Exit` primitive, lifted from Effect's success/failure
// channel idea: a value that is either an `Ok<A>` or an `Err<E>`, discriminated
// by a literal `ok` boolean. Functions that can fail in a *known* way return
// `Result<A, E>` instead of throwing, so call sites discriminate exhaustively on
// the error rather than `try`/`catch`-ing an untyped `unknown`.
//
// Defects (genuinely unexpected throws — DuckDB/IO blowing up, a programmer
// invariant) still propagate as exceptions; `Result` is only for the modelled,
// recoverable failures. `E` is intentionally generic: this primitive imposes no
// error shape, the domain unions (`GscError`, `QueryError`, `EngineError`) keep
// their own `kind` discriminant.
//
// Edge-safe: zero imports, no `node:*`, ships from `gscdump` core.

export interface Ok<A> {
  readonly ok: true
  readonly value: A
}

export interface Err<E> {
  readonly ok: false
  readonly error: E
}

export type Result<A, E> = Ok<A> | Err<E>

export function ok<A>(value: A): Ok<A> {
  return { ok: true, value }
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

export function isOk<A, E>(result: Result<A, E>): result is Ok<A> {
  return result.ok
}

export function isErr<A, E>(result: Result<A, E>): result is Err<E> {
  return !result.ok
}

/**
 * Collapses a `Result` back into the throwing world: returns the value or throws
 * via `toError`. Used by the throwing wrappers that sit over the `Result` core so
 * existing call sites keep their `await`/`throw` ergonomics.
 */
export function unwrapResult<A, E>(result: Result<A, E>, toError: (error: E) => unknown): A {
  if (result.ok)
    return result.value
  throw toError(result.error)
}
