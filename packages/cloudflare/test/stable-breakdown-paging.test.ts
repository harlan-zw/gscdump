import { buildArchetypeSql, TABLE_PLACEHOLDER } from '@gscdump/cloudflare/server-tail'
import { it } from 'vitest'
import { pagingArchetype, verifyPaging } from '../../engine/test/helpers/breakdown-paging'

it.each([false, true])('exports tied server breakdown rows with comparison=%s', async (comparison) => {
  await verifyPaging((limit) => {
    const plan = buildArchetypeSql(pagingArchetype(limit, comparison), { partitionPruned: true })
    return { ...plan, sql: plan.sql.replaceAll(TABLE_PLACEHOLDER, 'queries') }
  }, comparison)
})

it('exports tied new-query movers without losing rows at page boundaries', async () => {
  await verifyPaging((limit) => {
    const query = { ...pagingArchetype(limit, true), compareRange: { start: '2026-01-01', end: '2026-01-31' }, movers: 'new' as const }
    const plan = buildArchetypeSql(query, { partitionPruned: true })
    return { ...plan, sql: plan.sql.replaceAll(TABLE_PLACEHOLDER, 'queries') }
  })
})
