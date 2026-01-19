import type { DimensionFilterGroup, SearchAnalyticsQuery } from '../core/types'
import type { BuilderState, DateOperator, Filter, InternalFilter } from './types'

const DATE_OPERATORS: DateOperator[] = ['gte', 'gt', 'lte', 'lt', 'between']

function isDateOperator(op: string): op is DateOperator {
  return DATE_OPERATORS.includes(op as DateOperator)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

interface DateExtraction {
  startDate?: string
  endDate?: string
  nonDateFilters: Filter<any>[]
}

/**
 * Extract date range from filters. Used by analysis functions to get the period.
 */
export function extractDateRange(filters: Filter<any>[]): { startDate?: string, endDate?: string } {
  const { startDate, endDate } = extractDateFilters(filters)
  return { startDate, endDate }
}

function extractDateFilters(filters: Filter<any>[]): DateExtraction {
  let startDate: string | undefined
  let endDate: string | undefined
  const nonDateFilters: Filter<any>[] = []

  for (const filter of filters) {
    const dateFilters: InternalFilter[] = []
    const otherFilters: InternalFilter[] = []

    for (const f of filter._filters) {
      if (f.dimension === 'date' && isDateOperator(f.operator)) {
        dateFilters.push(f)
      }
      else {
        otherFilters.push(f)
      }
    }

    // Process date filters
    for (const df of dateFilters) {
      switch (df.operator) {
        case 'gte':
          startDate = df.expression
          break
        case 'gt':
          // gt = exclusive, so add 1 day
          startDate = addDays(df.expression, 1)
          break
        case 'lte':
          endDate = df.expression
          break
        case 'lt':
          // lt = exclusive, so subtract 1 day
          endDate = addDays(df.expression, -1)
          break
        case 'between':
          startDate = df.expression
          endDate = df.expression2
          break
      }
    }

    // Keep non-date filters
    if (otherFilters.length > 0) {
      nonDateFilters.push({
        ...filter,
        _filters: otherFilters,
      } as Filter<any>)
    }
  }

  return { startDate, endDate, nonDateFilters }
}

export function resolveToBody(state: BuilderState): SearchAnalyticsQuery {
  // Extract date constraints from filters
  const { startDate, endDate, nonDateFilters } = extractDateFilters(state.filters)

  if (!startDate || !endDate) {
    throw new Error('Date range required: use .where(between(date, start, end)) or .where(gte(date, start)).where(lte(date, end))')
  }

  const body: SearchAnalyticsQuery = {
    dimensions: state.dimensions,
    startDate,
    endDate,
  }

  if (state.rowLimit) {
    body.rowLimit = state.rowLimit
  }

  const filterGroups = resolveFilters(nonDateFilters)
  if (filterGroups.length > 0) {
    body.dimensionFilterGroups = filterGroups
  }

  return body
}

function resolveFilters(filters: Filter<any>[]): DimensionFilterGroup[] {
  const groups: DimensionFilterGroup[] = []

  for (const filter of filters) {
    const groupType = filter._groupType ?? 'and'

    if (groupType === 'or' && filter._filters.length > 1) {
      // OR group - each filter becomes separate group with OR logic
      // GSC API limitation: can only have AND between groups, OR within groups
      groups.push({
        groupType: 'or',
        filters: filter._filters.map(f => ({
          dimension: f.dimension,
          operator: f.operator,
          expression: f.expression,
        })),
      })
    }
    else if (filter._filters.length > 0) {
      // AND - add filters to default group
      groups.push({
        filters: filter._filters.map(f => ({
          dimension: f.dimension,
          operator: f.operator,
          expression: f.expression,
        })),
      })
    }
  }

  return groups
}
