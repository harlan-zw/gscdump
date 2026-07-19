// The typed error (`E`) channel for `@gscdump/engine`'s modelled, caller-actionable
// failures, mirroring `gscdump`'s `kind`-discriminated convention (not `_tag`).
// Pairs with `Result` from `gscdump/result`: a `fooResult(): Result<A, EngineError>`
// core models the expected failures, a thin throwing `foo()` wrapper preserves
// existing call sites via `unwrapResult(..., engineErrorToException)`.
//
// Defects — DuckDB / hyparquet / proper-lockfile / PyIceberg IO blowing up, a
// programmer invariant — are NOT modelled here; they keep propagating as
// exceptions. `EngineError` is only for the expected, recoverable cases callers
// branch on (a bad SQL literal handed to the edge binder, an unknown analyzer,
// a query whose tables aren't attached, a write that lost every CAS round).

export type EngineErrorKind
  = | 'analyzer-not-found'
    | 'analyzer-capability-missing'
    | 'invalid-sql-literal'
    | 'placeholder-arity-mismatch'
    | 'invalid-search-types'
    | 'attached-table-missing'
    | 'manifest-cas-exhausted'
    | 'invalid-snapshot-filename'
    | 'unsupported-snapshot-index-version'
    | 'invalid-schema-identifier'
    | 'invalid-year-month'
    | 'missing-attach-url'
    | 'manifest-cas-round-lost'
    | 'iceberg-table-op-failed'
    | 'sink-table-flush-failed'
    | 'rollup-build-failed'
    | 'lock-acquire-timeout'

export type EngineError
  = | { kind: 'analyzer-not-found', tool: string, message: string }
    | { kind: 'analyzer-capability-missing', tool: string, missing: readonly string[], message: string }
    | { kind: 'invalid-sql-literal', message: string }
    | { kind: 'placeholder-arity-mismatch', message: string }
    | { kind: 'invalid-search-types', message: string, cause?: unknown }
    | { kind: 'attached-table-missing', missing: readonly string[], message: string }
    | { kind: 'manifest-cas-exhausted', message: string, siteId: string, table: string, attempts: number }
    | { kind: 'invalid-snapshot-filename', message: string, fileName: string }
    | { kind: 'unsupported-snapshot-index-version', message: string, version: unknown }
    | { kind: 'invalid-schema-identifier', message: string, schema: string }
    | { kind: 'invalid-year-month', message: string, value: string }
    | { kind: 'missing-attach-url', message: string, fileName: string }
    // A single CAS round of the R2 manifest write loop lost the conditional-PUT
    // race (412/precondition-failed). NOT terminal — the loop re-reads HEAD and
    // retries; only `manifest-cas-exhausted` is the give-up failure.
    | { kind: 'manifest-cas-round-lost', message: string, siteId: string, table: string, attempt: number }
    // One Iceberg catalog table create/drop failed (e.g. "table already exists",
    // a catalog 5xx). Captured per-table so a partial provisioning run is
    // observable. `cause` carries the original thrown value.
    | { kind: 'iceberg-table-op-failed', message: string, op: 'create' | 'drop', table: string, cause?: unknown }
    // One table's buffered rows failed to reach durable storage on `Sink.close()`.
    // Captured per-table so the un-flushed slices are NOT ledger-recorded while
    // the tables that did commit still are. `cause` carries the original error.
    | { kind: 'sink-table-flush-failed', message: string, table: string, cause?: unknown }
    // One rollup def's build/encode/write threw. Captured so one bad rollup
    // never aborts the rest of the batch. `cause` carries the original error.
    | { kind: 'rollup-build-failed', message: string, id: string, cause?: unknown }
    // A scoped `withLock` could not acquire the lease before its deadline under
    // contention. Caller-actionable: back off and retry, or fail the unit of work.
    | { kind: 'lock-acquire-timeout', message: string, scope: string, timeoutMs: number }

export const engineErrors = {
  analyzerNotFound(tool: string): EngineError {
    return { kind: 'analyzer-not-found', tool, message: `analyzer "${tool}" requires capabilities [executeSql] not provided by source` }
  },
  analyzerCapabilityMissing(tool: string, missing: readonly string[]): EngineError {
    return { kind: 'analyzer-capability-missing', tool, missing, message: `analyzer "${tool}" requires capabilities [${missing.join(', ')}] not provided by source` }
  },
  nonFiniteNumberLiteral(value: number): EngineError {
    return { kind: 'invalid-sql-literal', message: `cannot inline non-finite number: ${value}` }
  },
  controlCharsInLiteral(): EngineError {
    return { kind: 'invalid-sql-literal', message: 'string literal contains disallowed control characters' }
  },
  uninlinableLiteralType(type: string): EngineError {
    return { kind: 'invalid-sql-literal', message: `cannot inline value of type ${type}` }
  },
  morePlaceholdersThanParams(have: number): EngineError {
    return { kind: 'placeholder-arity-mismatch', message: `bindLiterals: more '?' placeholders than params (have ${have})` }
  },
  dollarPlaceholderOutOfRange(n: number, have: number): EngineError {
    return { kind: 'placeholder-arity-mismatch', message: `bindLiterals: $${n} out of range (have ${have} params)` }
  },
  mixedPlaceholderStyles(): EngineError {
    return { kind: 'placeholder-arity-mismatch', message: 'bindLiterals: cannot mix \'?\' and \'$N\' placeholders in the same query' }
  },
  unusedParams(unused: number): EngineError {
    return { kind: 'placeholder-arity-mismatch', message: `bindLiterals: ${unused} params unused` }
  },
  searchTypesNotArray(): EngineError {
    return { kind: 'invalid-search-types', message: 'enabledSearchTypes must be a non-empty array' }
  },
  unknownSearchType(value: unknown): EngineError {
    return { kind: 'invalid-search-types', message: `enabledSearchTypes: unknown searchType ${String(value)}` }
  },
  searchTypesMissingWeb(): EngineError {
    return { kind: 'invalid-search-types', message: 'enabledSearchTypes must include "web"' }
  },
  attachedTableMissing(missing: readonly string[]): EngineError {
    return { kind: 'attached-table-missing', missing, message: `attached-table source: required table(s) not attached: ${missing.join(', ')}` }
  },
  manifestCasExhausted(siteId: string, table: string, attempts: number): EngineError {
    return { kind: 'manifest-cas-exhausted', siteId, table, attempts, message: `R2 manifest CAS exceeded ${attempts} retries for ${siteId}/${table}` }
  },
  invalidSnapshotFilename(fileName: string): EngineError {
    return { kind: 'invalid-snapshot-filename', fileName, message: `snapshotAlias: unrecognised filename ${JSON.stringify(fileName)}` }
  },
  unsupportedSnapshotIndexVersion(version: unknown): EngineError {
    return { kind: 'unsupported-snapshot-index-version', version, message: `attachSnapshotIndex: unsupported snapshot index version ${String(version)}; expected 1` }
  },
  invalidSchemaIdentifier(schema: string): EngineError {
    return { kind: 'invalid-schema-identifier', schema, message: `attachSnapshotIndex: invalid schema identifier ${JSON.stringify(schema)}` }
  },
  invalidYearMonth(value: string): EngineError {
    return { kind: 'invalid-year-month', value, message: `attachSnapshotIndex: invalid YYYY-MM entry ${JSON.stringify(value)} in index.cold` }
  },
  missingAttachUrl(fileName: string): EngineError {
    return { kind: 'missing-attach-url', fileName, message: `attachSnapshotIndex: attachUrls missing entry for ${fileName}` }
  },
  manifestCasRoundLost(siteId: string, table: string, attempt: number): EngineError {
    return { kind: 'manifest-cas-round-lost', siteId, table, attempt, message: `R2 manifest CAS round ${attempt} lost the conditional-PUT race for ${siteId}/${table}` }
  },
  icebergTableOpFailed(op: 'create' | 'drop', table: string, cause: unknown): EngineError {
    return { kind: 'iceberg-table-op-failed', op, table, cause, message: String(cause) }
  },
  sinkTableFlushFailed(table: string, cause: unknown): EngineError {
    return { kind: 'sink-table-flush-failed', table, cause, message: String(cause) }
  },
  rollupBuildFailed(id: string, cause: unknown): EngineError {
    return { kind: 'rollup-build-failed', id, cause, message: cause instanceof Error ? (cause.stack || cause.message) : String(cause) }
  },
  lockAcquireTimeout(scope: string, timeoutMs: number): EngineError {
    return { kind: 'lock-acquire-timeout', scope, timeoutMs, message: `withLock: timed out acquiring ${scope} after ${timeoutMs}ms` }
  },
} as const

const ENGINE_ERROR_KINDS = new Set<EngineErrorKind>([
  'analyzer-not-found',
  'analyzer-capability-missing',
  'invalid-sql-literal',
  'placeholder-arity-mismatch',
  'invalid-search-types',
  'attached-table-missing',
  'manifest-cas-exhausted',
  'invalid-snapshot-filename',
  'unsupported-snapshot-index-version',
  'invalid-schema-identifier',
  'invalid-year-month',
  'missing-attach-url',
  'manifest-cas-round-lost',
  'iceberg-table-op-failed',
  'sink-table-flush-failed',
  'rollup-build-failed',
  'lock-acquire-timeout',
])

export function isEngineError(value: unknown): value is EngineError {
  return typeof value === 'object'
    && value !== null
    && ENGINE_ERROR_KINDS.has((value as { kind?: EngineErrorKind }).kind as EngineErrorKind)
    && typeof (value as { message?: unknown }).message === 'string'
}

/**
 * Re-raises an `EngineError` value as a generic `Error`, stashing the union under
 * `.engineError` for stack-walking. Used by the throwing wrappers over the
 * `Result`-returning cores whose original throws were bare `Error`s (the SQL
 * binder, sync-config). Modules that historically threw a *named* class
 * (`AnalyzerCapabilityError`, `AttachedTableMissingError`) provide their own
 * mapper so the class identity callers match on is preserved.
 */
export function engineErrorToException(error: EngineError): Error {
  const exception = new Error(error.message)
  if ('cause' in error && error.cause !== undefined)
    (exception as Error & { cause?: unknown }).cause = error.cause
  ;(exception as Error & { engineError?: EngineError }).engineError = error
  return exception
}
