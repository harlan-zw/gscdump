import type { Dimension } from 'gscdump/query'
import type { LogicalDataset } from 'gscdump/query/plan'

export type { LogicalDataset }
export type DimensionSurface = 'api' | 'stored' | 'derived'

export interface DimensionBinding {
  column: string
  surfaces: readonly DimensionSurface[]
}

export interface LogicalDatasetDefinition {
  dimensions: Partial<Record<Dimension, DimensionBinding>>
}

export const DIMENSION_SURFACES: Record<Dimension, readonly DimensionSurface[]> = {
  page: ['api', 'stored'],
  query: ['api', 'stored'],
  queryCanonical: ['stored', 'derived'],
  country: ['api', 'stored'],
  device: ['api', 'stored'],
  searchAppearance: ['api', 'stored'],
  date: ['api', 'stored'],
  hour: ['api', 'stored'],
}

export const LOGICAL_DATASETS: Record<LogicalDataset, LogicalDatasetDefinition> = {
  pages: {
    dimensions: {
      page: { column: 'url', surfaces: ['api', 'stored'] },
      date: { column: 'date', surfaces: ['api', 'stored'] },
    },
  },
  keywords: {
    dimensions: {
      query: { column: 'query', surfaces: ['api', 'stored'] },
      queryCanonical: { column: 'query_canonical', surfaces: ['stored', 'derived'] },
      date: { column: 'date', surfaces: ['api', 'stored'] },
    },
  },
  page_keywords: {
    dimensions: {
      page: { column: 'url', surfaces: ['api', 'stored'] },
      query: { column: 'query', surfaces: ['api', 'stored'] },
      queryCanonical: { column: 'query_canonical', surfaces: ['stored', 'derived'] },
      date: { column: 'date', surfaces: ['api', 'stored'] },
    },
  },
  countries: {
    dimensions: {
      country: { column: 'country', surfaces: ['api', 'stored'] },
      date: { column: 'date', surfaces: ['api', 'stored'] },
    },
  },
  devices: {
    dimensions: {
      device: { column: 'device', surfaces: ['api', 'stored'] },
      date: { column: 'date', surfaces: ['api', 'stored'] },
    },
  },
  search_appearance: {
    dimensions: {
      searchAppearance: { column: 'searchAppearance', surfaces: ['api', 'stored'] },
      date: { column: 'date', surfaces: ['api', 'stored'] },
    },
  },
  hourly_pages: {
    dimensions: {
      page: { column: 'url', surfaces: ['api', 'stored'] },
      date: { column: 'date', surfaces: ['api', 'stored'] },
      hour: { column: 'hour', surfaces: ['api', 'stored'] },
    },
  },
}

// Single source of truth lives in the planner (`gscdump/query/plan`). The
// engine resolver previously kept a duplicate of this routing logic; the
// re-export keeps one definition so the two can never drift.
// `inferLogicalDataset` is the engine-facing name for the planner's
// `inferDataset`.
export {
  inferDataset as inferLogicalDataset,
  isDatasetResolvable,
  UnresolvableDatasetError,
} from 'gscdump/query/plan'

export function dimensionColumn(dim: Dimension, dataset: LogicalDataset): string {
  return LOGICAL_DATASETS[dataset].dimensions[dim]?.column ?? dim
}

export function supportsDimensionOnSurface(
  dim: Dimension,
  surface: DimensionSurface,
): boolean {
  return DIMENSION_SURFACES[dim].includes(surface)
}

export function assertDimensionsSupported(
  dimensions: readonly Dimension[],
  surface: DimensionSurface,
  context: string,
): void {
  const unsupported = dimensions.filter(dim => !supportsDimensionOnSurface(dim, surface))
  if (unsupported.length === 0)
    return

  throw new Error(`${context}: unsupported dimensions for ${surface}: ${unsupported.join(', ')}`)
}
