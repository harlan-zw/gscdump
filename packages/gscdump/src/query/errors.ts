// The typed error (`E`) channel for the query builder + logical planner. Every
// *expected* failure in turning a `BuilderState` into a GSC API body or a
// logical plan is a value with a `kind` discriminant (matching the repo's
// `GscError` convention, not `_tag`) plus the data needed to act on it, never a
// bare `throw new Error('...')`. Boundary functions expose a `Result`-returning
// core (`resolveToBodyResult`, `buildLogicalPlanResult`) so partner endpoints can
// map a bad query to a 4xx; thin throwing wrappers preserve existing call sites.
//
// Defects (a genuine planner bug, an impossible state) still propagate as
// exceptions. `QueryError` is only for modelled, caller-actionable query mistakes.
//
// Leaf module: imports only a *type* from `./types`, so neither `plan.ts` nor
// `resolver.ts` (which both depend on this) form an import cycle.

import type { Dimension } from './types'

export type QueryErrorKind
  = | 'missing-date-range'
    | 'invalid-row-limit'
    | 'invalid-start-row'
    | 'invalid-data-state'
    | 'invalid-aggregation-type'
    | 'invalid-builder-state'
    | 'invalid-filter'
    | 'unsupported-capability'
    | 'unresolvable-dataset'

export type QueryError
  = | { kind: 'missing-date-range', message: string }
    | { kind: 'invalid-row-limit', value: unknown, message: string }
    | { kind: 'invalid-start-row', value: unknown, message: string }
    | { kind: 'invalid-data-state', message: string }
    | { kind: 'invalid-aggregation-type', message: string }
    | { kind: 'invalid-builder-state', message: string, cause?: unknown }
    | { kind: 'invalid-filter', message: string }
    | { kind: 'unsupported-capability', capability: string, context: string, message: string }
    | { kind: 'unresolvable-dataset', dimensions: readonly Dimension[], filterDims: readonly Dimension[], message: string }

// Local copy of the planner's time-axis set, used only to render the
// `unresolvable-dataset` message. Kept here (rather than imported from `plan.ts`)
// to keep this module a dependency-free leaf; `plan.ts` owns the authoritative
// `TIME_AXIS_DIMENSIONS` used for the actual resolvability check.
const TIME_AXIS_DIMENSIONS = new Set<Dimension>(['date', 'hour'])

export const queryErrors = {
  missingDateRange(): QueryError {
    return {
      kind: 'missing-date-range',
      message: 'Date range required: use .where(between(date, start, end)) or .where(and(gte(date, start), lte(date, end)))',
    }
  },
  invalidRowLimit(value: unknown): QueryError {
    return { kind: 'invalid-row-limit', value, message: `rowLimit must be a positive integer, got ${value}` }
  },
  invalidStartRow(value: unknown): QueryError {
    return { kind: 'invalid-start-row', value, message: `startRow must be a non-negative integer, got ${value}` }
  },
  hourDimensionRequiresHourlyState(): QueryError {
    return { kind: 'invalid-data-state', message: 'hour dimension requires dataState: "hourly_all"' }
  },
  hourlyStateRequiresHourDimension(): QueryError {
    return { kind: 'invalid-data-state', message: 'dataState: "hourly_all" requires grouping by hour dimension' }
  },
  byPropertyUnsupportedSearchType(): QueryError {
    return { kind: 'invalid-aggregation-type', message: 'aggregationType: "byProperty" is not supported for type "discover" or "googleNews"' }
  },
  byPropertyNotAllowedWithPage(): QueryError {
    return { kind: 'invalid-aggregation-type', message: 'aggregationType: "byProperty" is not allowed when grouping or filtering by page' }
  },
  byNewsShowcaseRequiresSearchType(): QueryError {
    return { kind: 'invalid-aggregation-type', message: 'aggregationType: "byNewsShowcasePanel" requires type "discover" or "googleNews"' }
  },
  byNewsShowcaseNotAllowedWithPage(): QueryError {
    return { kind: 'invalid-aggregation-type', message: 'aggregationType: "byNewsShowcasePanel" is not allowed when grouping or filtering by page' }
  },
  byNewsShowcaseRequiresShowcaseFilter(): QueryError {
    return { kind: 'invalid-aggregation-type', message: 'aggregationType: "byNewsShowcasePanel" requires a searchAppearance equals "NEWS_SHOWCASE" filter and no other searchAppearance filter' }
  },
  invalidBuilderState(cause?: unknown): QueryError {
    return { kind: 'invalid-builder-state', cause, message: 'Invalid state' }
  },
  malformedFilterLeaf(): QueryError {
    return { kind: 'invalid-filter', message: 'Malformed filter: each leaf requires a string `dimension` and `operator`. Each nested group requires a `_filters` array.' }
  },
  unsupportedCapability(capability: string, context: string): QueryError {
    return { kind: 'unsupported-capability', capability, context, message: `${context} requires ${capability} capability` }
  },
  unresolvableDataset(dimensions: readonly Dimension[], filterDims: readonly Dimension[] = []): QueryError {
    const grouped = dimensions.filter(d => !TIME_AXIS_DIMENSIONS.has(d))
    const filtered = filterDims.filter(d => !TIME_AXIS_DIMENSIONS.has(d))
    return {
      kind: 'unresolvable-dataset',
      dimensions,
      filterDims,
      message: `Cannot resolve a [${grouped.join(', ')}] breakdown filtered by [${filtered.join(', ')}] `
        + `from stored data: these dimensions live in separate per-dimension tables. `
        + `Only the live GSC API computes cross-dimension aggregates.`,
    }
  },
} as const

const QUERY_ERROR_KINDS = new Set<QueryErrorKind>([
  'missing-date-range',
  'invalid-row-limit',
  'invalid-start-row',
  'invalid-data-state',
  'invalid-aggregation-type',
  'invalid-builder-state',
  'invalid-filter',
  'unsupported-capability',
  'unresolvable-dataset',
])

export function isQueryError(value: unknown): value is QueryError {
  return typeof value === 'object'
    && value !== null
    && QUERY_ERROR_KINDS.has((value as { kind?: QueryErrorKind }).kind as QueryErrorKind)
    && typeof (value as { message?: unknown }).message === 'string'
}

/**
 * Thrown when a query needs a planner capability (regex pushdown, comparison
 * joins, multi-dataset reads) the target engine lacks. Engines catch it to fall
 * back to the live GSC API. Carries the typed `queryError` value so a caller can
 * read the modelled failure instead of parsing the message.
 */
export class UnsupportedLogicalCapabilityError extends Error {
  readonly queryError: Extract<QueryError, { kind: 'unsupported-capability' }>
  constructor(capability: string, context: string) {
    const error = queryErrors.unsupportedCapability(capability, context) as Extract<QueryError, { kind: 'unsupported-capability' }>
    super(error.message)
    this.name = 'UnsupportedLogicalCapabilityError'
    this.queryError = error
  }
}

/**
 * Thrown when a query's grouped + filtered dimensions span more than one stored
 * dataset. Replaces the resolver's raw "unknown column" error so hosts can map
 * it to a 4xx instead of leaking an opaque 500. Carries the typed `queryError`.
 */
export class UnresolvableDatasetError extends Error {
  readonly queryError: Extract<QueryError, { kind: 'unresolvable-dataset' }>
  constructor(dimensions: readonly Dimension[], filterDims: readonly Dimension[] = []) {
    const error = queryErrors.unresolvableDataset(dimensions, filterDims) as Extract<QueryError, { kind: 'unresolvable-dataset' }>
    super(error.message)
    this.name = 'UnresolvableDatasetError'
    this.queryError = error
  }
}

/**
 * Re-raises a `QueryError` value as an `Error`, preserving the historical class
 * identity for the two errors engines match on by name (`UnresolvableDatasetError`,
 * `UnsupportedLogicalCapabilityError`). Pairs with `unwrapResult` so a
 * `fooResult(): Result<A, QueryError>` core can back a throwing `foo()`.
 */
export function queryErrorToException(error: QueryError): Error {
  switch (error.kind) {
    case 'unsupported-capability':
      return new UnsupportedLogicalCapabilityError(error.capability, error.context)
    case 'unresolvable-dataset':
      return new UnresolvableDatasetError(error.dimensions, error.filterDims)
    default: {
      const exception = new Error(error.message)
      if ('cause' in error && error.cause !== undefined)
        (exception as Error & { cause?: unknown }).cause = error.cause
      ;(exception as Error & { queryError?: QueryError }).queryError = error
      return exception
    }
  }
}
