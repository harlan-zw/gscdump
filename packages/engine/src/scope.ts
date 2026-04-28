/**
 * Shared scope helpers for engine runners.
 *
 * Builds per-table predicates from {siteId, window} that compose with user-
 * level filters via `mergeScope`. Generic over the schema so engine-sqlite
 * (every table has site_id) and engine-duckdb-wasm (per-site snapshots, site_id
 * usually absent) can both use it.
 */

import type { SQL } from 'drizzle-orm'

import { and, eq, gte, lte } from 'drizzle-orm'

/**
 * Structural subset of `ResolvedWindow` from `@gscdump/engine/period`.
 * Inlined here to avoid the cross-module type import in this leaf module;
 * any object with `start`/`end` strings (and optional `days`) satisfies it.
 */
export interface ResolvedWindow {
  start: string
  end: string
  days?: number
}

export interface ScopedRunnerOptions {
  siteId?: string
  window?: ResolvedWindow
  /** Inclusive lower bound for `date`. Ignored if `window` is supplied. */
  startDate?: string
  /** Inclusive upper bound for `date`. Ignored if `window` is supplied. */
  endDate?: string
}

export interface TableScope {
  wherePredicates: SQL[]
  window?: ResolvedWindow
  siteId?: string
}

export function buildTableScope(
  table: Record<string, any>,
  opts: ScopedRunnerOptions,
): TableScope {
  const predicates: SQL[] = []

  if (opts.siteId && 'site_id' in table)
    predicates.push(eq(table.site_id, opts.siteId))

  if ('date' in table) {
    const start = opts.window?.start ?? opts.startDate
    const end = opts.window?.end ?? opts.endDate
    if (start)
      predicates.push(gte(table.date, start))
    if (end)
      predicates.push(lte(table.date, end))
  }

  return { wherePredicates: predicates, window: opts.window, siteId: opts.siteId }
}

export function mergeScope(scope: TableScope, ...extra: SQL[]): SQL | undefined {
  const all = [...scope.wherePredicates, ...extra].filter(Boolean) as SQL[]
  if (all.length === 0)
    return undefined
  return and(...all)
}

/**
 * Bind `buildTableScope` + `mergeScope` to a specific drizzle schema. Engine
 * adapters (`engine-sqlite`, `engine-duckdb-wasm`) call this once at module load and
 * re-export the returned `scopeFor` / `mergeScope` so consumers get a typed
 * `keyof Schema` table parameter without each adapter re-implementing the
 * pass-through wrapper.
 */
export function createScopedHelpers<S extends Record<string, Record<string, any>>>(
  schema: S,
): {
  scopeFor: (table: keyof S, opts: ScopedRunnerOptions) => TableScope
  mergeScope: typeof mergeScope
} {
  return {
    scopeFor: (table, opts) => buildTableScope(schema[table] as Record<string, any>, opts),
    mergeScope,
  }
}
