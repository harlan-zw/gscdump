import { resolveParquetSQL, substituteNamedFiles } from '@gscdump/engine/planner'
import { pgResolverAdapter, resolveComparisonSQL, resolveToSQL, resolveToSQLOptimized } from '@gscdump/engine/resolver'
import { describe, it } from 'vitest'
import { pagingState, parquetPath, previousRange, verifyCompositePaging, verifyPaging } from './helpers/breakdown-paging'

describe('complete breakdown exports with tied metrics', () => {
  const compilers = {
    resolver: (limit: number) => resolveToSQL(pagingState(limit), { adapter: pgResolverAdapter }),
    optimized: (limit: number) => resolveToSQLOptimized(pagingState(limit), { adapter: pgResolverAdapter }),
    comparison: (limit: number) => resolveComparisonSQL(pagingState(limit), pagingState(limit, previousRange), { adapter: pgResolverAdapter }),
    movers: (limit: number) => resolveComparisonSQL(pagingState(limit), pagingState(limit, previousRange), { adapter: pgResolverAdapter }, undefined, { column: 'clicksChange', dir: 'asc' }),
    parquet: (limit: number) => {
      const plan = resolveParquetSQL(pagingState(limit), 'queries')
      return { ...plan, sql: substituteNamedFiles(plan.sql, { FILES: [parquetPath] }) }
    },
  }
  it.each(Object.entries(compilers))('%s keeps page boundaries stable when the requested limit changes', async (name, compile) => {
    await verifyPaging(compile, name === 'comparison' || name === 'movers')
  })

  it.each([resolveToSQL, resolveToSQLOptimized])('uses every grouped dimension when row keys are composite', async (compile) => {
    await verifyCompositePaging(limit => compile({ ...pagingState(limit), dimensions: ['query', 'page'] }, { adapter: pgResolverAdapter }))
  })
})
