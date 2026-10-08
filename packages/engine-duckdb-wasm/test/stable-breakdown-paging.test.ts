import { compileArchetypeSql } from '@gscdump/engine-duckdb-wasm'
import { it } from 'vitest'
import { pagingArchetype, verifyPaging } from '../../engine/test/helpers/breakdown-paging'

it.each([false, true])('exports tied browser SQL breakdown rows with comparison=%s', async (comparison) => {
  await verifyPaging(limit => compileArchetypeSql(pagingArchetype(limit, comparison)), comparison)
})

it('exports tied new-query movers without losing rows at page boundaries', async () => {
  await verifyPaging(limit => compileArchetypeSql({
    ...pagingArchetype(limit, true),
    compareRange: { start: '2026-01-01', end: '2026-01-31' },
    movers: 'new',
  }))
})
