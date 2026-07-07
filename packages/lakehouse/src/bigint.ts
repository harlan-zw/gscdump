/**
 * BigInt at JSON boundaries — the single place this policy lives.
 *
 * int64 reaches serialization from two origins:
 *  1. DuckDB `SUM`/`COUNT` aggregates — already coerced to `number` at the
 *     source-factory boundary (`@gscdump/engine` `coerceRows`), so rows are
 *     BigInt-free by the time they cross the query boundary.
 *  2. icebird / REST-catalog metadata (`current-snapshot-id`, `sequence-number`,
 *     `snapshot-id`) and other identity ids — these never pass through a source,
 *     so they arrive at envelope / cache / log serializers still as BigInt.
 *
 * A plain `JSON.stringify` throws `Do not know how to serialize a BigInt`, which
 * is how a stray identity int64 turns into a request 500. Any boundary that can
 * see origin (2) must serialize through here.
 *
 * TWO policies, because the correct target type depends on what the value is:
 *
 *  - Identity / precision values (snapshot ids, large row ids) can exceed 2^53
 *    and must round-trip losslessly → serialize as a decimal STRING. Use
 *    {@link stringifyBigintSafe} / {@link bigintJsonReplacer} / {@link encodeJsonBigintSafe}
 *    for storage / transport / log serialization. Where values are already
 *    number-coerced (origin 1), the replacer is a no-op backstop.
 *
 *  - Analytics aggregates that you want as real numbers downstream → coerce with
 *    {@link coerceBigIntToNumber}. Lossy above 2^53 by design; click / impression
 *    columns never reach that range. This is the scalar behind engine `coerceRows`.
 */

/** `JSON.stringify` replacer: BigInt → decimal string (lossless). Pass-through otherwise. */
export function bigintJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** `JSON.stringify` that never throws on BigInt; identity ids stay lossless as strings. */
export function stringifyBigintSafe(value: unknown, space?: string | number): string {
  return JSON.stringify(value, bigintJsonReplacer, space)
}

/** UTF-8 JSON bytes, BigInt-safe — the payload shape for `DataSource.write`. */
export function encodeJsonBigintSafe(value: unknown): Uint8Array {
  return new TextEncoder().encode(stringifyBigintSafe(value))
}

/**
 * BigInt → number for analytics aggregates (< 2^53). Lossy above; acceptable for
 * click / impression sums. Non-BigInt values pass through untouched.
 */
export function coerceBigIntToNumber<T>(value: T): T | number {
  return typeof value === 'bigint' ? Number(value) : value
}
