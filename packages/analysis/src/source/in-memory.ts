import type { QueryRow, RowQuerySource } from '@gscdump/engine/resolver'
import type { BuilderState } from 'gscdump/query'

import type { PlannerCapabilities } from 'gscdump/query/plan'

/**
 * Permissive defaults: in-memory sources are usually test doubles, so they
 * advertise every capability unless the test explicitly narrows them.
 */
export const IN_MEMORY_DEFAULT_CAPABILITIES: PlannerCapabilities = {
  regex: true,
  multiDataset: true,
  comparisonJoin: true,
  windowTotals: true,
}

export interface InMemoryQuerySourceOptions {
  queryRows: (state: BuilderState) => Promise<QueryRow[]> | QueryRow[]
  capabilities?: PlannerCapabilities
}

export function createInMemoryQuerySource(
  options: InMemoryQuerySourceOptions,
): RowQuerySource {
  return {
    name: 'memory',
    capabilities: options.capabilities ?? IN_MEMORY_DEFAULT_CAPABILITIES,
    async queryRows(state: BuilderState): Promise<QueryRow[]> {
      return await options.queryRows(state)
    },
  }
}
