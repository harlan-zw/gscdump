import type { RecordReadRefusal } from '@gscdump/contracts'
import type { GscdumpV1Client } from '@gscdump/sdk/v1'
import type { BuilderState, Filter } from 'gscdump/query'

/** The public v1 rows operation accepts at most this many rows per request. */
const PAGE_SIZE = 25_000

interface WireFilter {
  _filters: unknown[]
  _nestedGroups?: WireFilter[]
  _groupType?: 'and' | 'or'
}

/** The builder carries a type-only `_constraints` key. The v1 contract rejects unknown keys, so keep the wire fields only. */
function toWireFilter(filter: Filter<any>): WireFilter {
  const source = filter as unknown as WireFilter
  return {
    _filters: source._filters,
    ...(source._nestedGroups ? { _nestedGroups: source._nestedGroups.map(group => toWireFilter(group as unknown as Filter<any>)) } : {}),
    ...(source._groupType ? { _groupType: source._groupType } : {}),
  }
}

/**
 * Read rows from the hosted record through the public v1 `analytics.rows.query`
 * operation. It pages with `startRow` up to `state.rowLimit`. It never calls Google.
 * When the record cannot serve the read, the host refuses it with a typed 409
 * that `describeCliError` renders, so a refusal never prints as an empty result.
 */
export async function queryHostedRows(client: GscdumpV1Client, siteId: string, state: BuilderState): Promise<Record<string, unknown>[]> {
  const limit = state.rowLimit ?? PAGE_SIZE
  const rows: Record<string, unknown>[] = []
  while (rows.length < limit) {
    const rowLimit = Math.min(PAGE_SIZE, limit - rows.length)
    const body = {
      ...state,
      ...(state.filter ? { filter: toWireFilter(state.filter) } : {}),
      ...(state.prefilter ? { prefilter: toWireFilter(state.prefilter) } : {}),
      rowLimit,
      ...(rows.length > 0 ? { startRow: (state.startRow ?? 0) + rows.length } : {}),
    }
    const page = (await client.queryAnalyticsRows({ params: { siteId }, body: body as never })).data.rows
    rows.push(...page)
    if (page.length < rowLimit)
      break
  }
  return rows
}

/** The CLI line for a hosted read the Site's record cannot serve, and the next step. Pure. */
export function describeRecordReadRefusal(refusal: RecordReadRefusal): { message: string, hint: string } {
  const running = refusal.syncStatus === 'syncing' || refusal.syncStatus === 'pending'
  if (refusal.reason === 'record_not_ready') {
    const hint = refusal.syncStatus === 'synced' && refusal.lastSyncAt !== undefined
      ? `Sync finished at ${utcMinute(refusal.lastSyncAt)}. gscdump prepares the record for reads after Sync. Try again in a few minutes.`
      : running
        ? 'Sync is still running. Run `gscdump sites` to see its progress, then try again when it finishes.'
        : 'Try again in a few minutes. Run `gscdump sites` to see the Sync state.'
    return { message: 'The Site\'s record is not readable yet.', hint }
  }
  const days = refusal.missingStart === refusal.missingEnd ? refusal.missingStart : `${refusal.missingStart} to ${refusal.missingEnd}`
  return { message: `The Site's record does not hold ${days}.`, hint: rangeHint(refusal, running) }
}

/**
 * `oldestDateSynced` and `newestDateSynced` are what Sync reports, and the
 * record can lag them. Days inside that range are not yet in the record, so
 * the hint never says the record holds them.
 */
function rangeHint(refusal: Extract<RecordReadRefusal, { reason: 'range_not_synced' }>, running: boolean): string {
  const { oldestDateSynced: oldest, newestDateSynced: newest } = refusal
  const synced = oldest !== undefined && newest !== undefined
  if (synced && refusal.missingStart >= oldest && refusal.missingEnd <= newest)
    return 'Sync covers these days, but the record does not hold them yet. Pick an earlier end date with --end, or try again later.'
  const covers = synced ? `Sync covers ${oldest} to ${newest}. ` : ''
  if (running)
    return `${covers}Sync is still running. Try again when it finishes.`
  return synced
    ? `${covers}Pick dates in that range with --start and --end.`
    : 'Run `gscdump sites` to see the Sync state.'
}

function utcMinute(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
