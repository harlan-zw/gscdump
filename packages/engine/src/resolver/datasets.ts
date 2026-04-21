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
  searchAppearance: ['api'],
  date: ['api', 'stored'],
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
}

export function inferLogicalDataset(
  dimensions: readonly Dimension[],
  filterDims: readonly Dimension[] = [],
): LogicalDataset {
  const allDims = new Set<Dimension>([...dimensions, ...filterDims])
  const has = (d: Dimension): boolean => allDims.has(d)

  if (has('searchAppearance')) {
    throw new Error(
      'searchAppearance is only supported by the live GSC API; offline analysis sources do not expose a matching dataset',
    )
  }

  if (has('page') && (has('query') || has('queryCanonical')))
    return 'page_keywords'
  if (has('query') || has('queryCanonical'))
    return 'keywords'
  if (has('page'))
    return 'pages'
  if (has('country'))
    return 'countries'
  if (has('device'))
    return 'devices'
  return 'keywords'
}

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
