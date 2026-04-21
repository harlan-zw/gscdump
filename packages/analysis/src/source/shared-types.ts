import type { DateRow, KeywordRow, PageRow } from '../types'

export type QueryDimension = 'keywords' | 'pages' | 'dates'

export interface QueryOptions {
  dimension?: QueryDimension
  limit?: number
}

export interface QueryResult {
  keywords: KeywordRow[]
  pages: PageRow[]
  dates: DateRow[]
}

export interface ComparisonQueryResult {
  current: QueryResult
  previous: QueryResult
}
