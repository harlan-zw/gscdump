/**
 * Analyzer registry. Pure value, no global state — `createAnalyzerRegistry`
 * returns an immutable lookup that maps tool ids to SQL/row variants.
 *
 * Callers compose their own registry from exported analyzer arrays:
 *
 *   import { ROW_ANALYZERS, SQL_ANALYZERS } from '@gscdump/analysis/registry'
 *   import { createAnalyzerRegistry } from '@gscdump/engine/analyzer'
 *   const registry = createAnalyzerRegistry({
 *     rows: ROW_ANALYZERS,
 *     sql: SQL_ANALYZERS,
 *   })
 */

import type { DefinedAnalyzer } from './define'
import type { Analyzer } from './types'

export interface AnalyzerVariants {
  sql?: Analyzer
  rows?: Analyzer
}

export interface AnalyzerRegistryInit {
  /**
   * Preferred for in-tree composition: pass `DefinedAnalyzer[]` directly so
   * SQL/row variants can never drift apart from their `defineAnalyzer` site.
   */
  defined?: readonly DefinedAnalyzer[]
  /** Flat-array path retained for narrow tree-shaken registry composition. */
  rows?: readonly Analyzer[]
  /** Flat-array path retained for narrow tree-shaken registry composition. */
  sql?: readonly Analyzer[]
}

export interface AnalyzerRegistry {
  listAnalyzerIds: () => readonly string[]
  getAnalyzerVariants: (id: string) => AnalyzerVariants | undefined
  resolveAnalyzer: (id: string, sourceSupportsSql: boolean) => Analyzer | undefined
  listAnalyzersFor: (sourceSupportsSql: boolean) => readonly Analyzer[]
  listAnalyzerIdsFor: (source: { executeSql?: unknown }) => readonly string[]
}

/**
 * Build an immutable registry from collections of row / SQL analyzers.
 * No global state; call this once per logical use (typically at startup
 * or per-request in a worker).
 */
export function createAnalyzerRegistry(init: AnalyzerRegistryInit = {}): AnalyzerRegistry {
  const byId = new Map<string, AnalyzerVariants>()

  for (const d of init.defined ?? []) {
    const entry = byId.get(d.id) ?? {}
    if (d.sql)
      entry.sql = d.sql
    if (d.rows)
      entry.rows = d.rows
    byId.set(d.id, entry)
  }
  for (const a of init.rows ?? []) {
    const entry = byId.get(a.id) ?? {}
    entry.rows = a
    byId.set(a.id, entry)
  }
  for (const a of init.sql ?? []) {
    const entry = byId.get(a.id) ?? {}
    entry.sql = a
    byId.set(a.id, entry)
  }

  const listAnalyzerIds = (): readonly string[] => [...byId.keys()].sort()

  const getAnalyzerVariants = (id: string): AnalyzerVariants | undefined => byId.get(id)

  const resolveAnalyzer = (id: string, sourceSupportsSql: boolean): Analyzer | undefined => {
    const variants = byId.get(id)
    if (!variants)
      return undefined
    if (sourceSupportsSql)
      return variants.sql ?? variants.rows
    return variants.rows
  }

  const listAnalyzersFor = (sourceSupportsSql: boolean): readonly Analyzer[] => {
    const out: Analyzer[] = []
    for (const id of listAnalyzerIds()) {
      const a = resolveAnalyzer(id, sourceSupportsSql)
      if (a)
        out.push(a)
    }
    return out
  }

  const listAnalyzerIdsFor = (source: { executeSql?: unknown }): readonly string[] => {
    const sourceSupportsSql = typeof source.executeSql === 'function'
    const out: string[] = []
    for (const id of listAnalyzerIds()) {
      if (resolveAnalyzer(id, sourceSupportsSql))
        out.push(id)
    }
    return out
  }

  return {
    listAnalyzerIds,
    getAnalyzerVariants,
    resolveAnalyzer,
    listAnalyzersFor,
    listAnalyzerIdsFor,
  }
}
