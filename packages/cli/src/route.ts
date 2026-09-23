// Routing policy: one decision for every read command. A read answers from
// the Store when the Store covers it, from the live Search Console API when
// the Site has no Store data at all, and otherwise tells the user the exact
// next command. One run never mixes Store rows and live rows: live returns
// top-N rows per request, while daily sync keeps more of the long tail.
//
// `decideRoute` is pure. The effectful shell below reads the inputs (auth,
// sync states, the sync-run record) and renders a stop.

import type { CoveragePlan, DateSpan } from '@gscdump/engine/analysis-range'
import type { SearchType } from 'gscdump/query'
import type { CommandContext } from './context'
import type { CoverageSyncState } from './coverage'
import type { LocalStore, SyncState, TableName } from './local-store'
import type { SyncRunStatus } from './sync-run'
import { buildCoveragePlan, gapsForRange } from '@gscdump/engine/analysis-range'
import { addDays } from 'gscdump/dates'
import { probeAuth } from './auth'
import { formatSiteResolution, siteArg } from './context'
import { hasSyncedDays, syncStateCoverageReader } from './coverage'
import { listStoreSites } from './store-sites'
import { isProcessAlive, readSyncRun, syncRunStatus } from './sync-run'

export type RouteAuth = 'none' | 'google' | 'hosted'

/** What a command reads from the Store. */
export type RouteNeed
  /** Every day of `window` for one table and search type. */
  = | { kind: 'window', table: TableName, searchType: SearchType, window: DateSpan }
  /** Any synced day of any of these tables. Raw SQL has no window. */
    | { kind: 'any', tables: readonly TableName[], searchType?: SearchType }

export type NeedCoverage
  = | { kind: 'window', table: TableName, searchType: SearchType, window: DateSpan, stored: boolean, gaps: DateSpan[] }
    | { kind: 'any', tables: readonly TableName[], searchType?: SearchType, stored: boolean }

export interface RouteRequest {
  /** The Site. Undefined when no Site resolved, for example with no auth and an empty Store. */
  site?: string
  /** What the user typed for the Site, to name it when it did not resolve. */
  siteHint?: string
  /** The command, for messages: `query`, `analyze movers`, `query --sql`. */
  label: string
  /** The Store can answer it. False for analyzers that exist only as live queries. */
  localCapable: boolean
  /** The live API can answer it. False for `--sql` and SQL-only analyzers. */
  liveCapable: boolean
  forceLive: boolean
  /** The command's arguments, to spell out a rerun with `--live`. */
  argv?: readonly string[]
}

export interface RouteState {
  auth: RouteAuth
  coverage: readonly NeedCoverage[]
  syncRun: SyncRunStatus
}

export type PromptReason
  /** Nothing can answer without Google, and Google is not connected. */
  = | { kind: 'not-connected', tables: TableName[] }
  /** The Store has no data for these tables, and the request cannot go to the live API. */
    | { kind: 'no-data', tables: TableName[] }
  /** The Store has some of the dates. */
    | { kind: 'partial', done: number, total: number, missing: DateSpan[] }
  /** `--live` on a request only the Store can answer. */
    | { kind: 'store-only' }
  /** Only the live API can answer, and the user did not pass `--live`. */
    | { kind: 'live-only' }

export type LiveReason = 'forced' | 'no-store-data'

export type Route
  = | { kind: 'local' }
    | { kind: 'live', reason: LiveReason }
    | { kind: 'syncing', done: number, total: number }
    | { kind: 'prompt', reason: PromptReason, nextCommand: string }

const CONNECT_COMMAND = 'gscdump init'
const LOGIN_COMMAND = 'gscdump auth login'

function isCovered(need: NeedCoverage): boolean {
  return need.kind === 'window' ? need.gaps.length === 0 : need.stored
}

function datesOf(spans: readonly DateSpan[]): Set<string> {
  const dates = new Set<string>()
  for (const span of spans) {
    for (let date = span.start; date <= span.end; date = addDays(date, 1))
      dates.add(date)
  }
  return dates
}

/** The sync command that fills the missing days of these needs. */
export function syncCommandFor(site: string | undefined, coverage: readonly NeedCoverage[]): string {
  const target = site ? siteArg(site) : 'example.com'
  const missing = coverage.filter(need => !isCovered(need))
  const gaps = missing.flatMap(need => need.kind === 'window' ? need.gaps : [])
  const tables = [...new Set(missing.flatMap(need => need.kind === 'window' ? [need.table] : need.tables))]
  const types = [...new Set(missing.flatMap(need => need.searchType && need.searchType !== 'web' ? [need.searchType] : []))]
  const parts = ['gscdump', 'sync', '--site', target]
  if (gaps.length > 0) {
    parts.push('--start', gaps.reduce((min, gap) => gap.start < min ? gap.start : min, gaps[0]!.start))
    parts.push('--end', gaps.reduce((max, gap) => gap.end > max ? gap.end : max, gaps[0]!.end))
  }
  if (tables.length > 0)
    parts.push('--tables', tables.join(','))
  if (types.length > 0)
    parts.push('--types', types.join(','))
  return parts.map(quote).join(' ')
}

function quote(part: string): string {
  return /^[\w:./=,@~-]+$/.test(part) ? part : `'${part.replaceAll('\'', '\'\\\'\'')}'`
}

/** The same command with `--live`. */
export function liveCommand(req: Pick<RouteRequest, 'argv' | 'label'>): string {
  const argv = req.argv ?? req.label.split(' ')
  return ['gscdump', ...argv, '--live'].map(quote).join(' ')
}

function runsForSite(syncRun: SyncRunStatus, site: string | undefined): syncRun is Extract<SyncRunStatus, { kind: 'running' }> {
  return syncRun.kind === 'running' && (site === undefined || syncRun.record.sites.includes(site))
}

/** Decide where a read goes. Pure. */
export function decideRoute(req: RouteRequest, state: RouteState): Route {
  const { auth, coverage, syncRun } = state
  const stored = coverage.some(need => need.stored)
  const covered = coverage.every(isCovered)
  const connected = auth !== 'none'
  const syncCommand = syncCommandFor(req.site ?? req.siteHint, coverage)
  const tables = [...new Set(coverage.flatMap(need => need.kind === 'window' ? [need.table] : need.tables))]
  const notConnected: Route = { kind: 'prompt', reason: { kind: 'not-connected', tables }, nextCommand: CONNECT_COMMAND }

  if (req.forceLive) {
    if (!req.liveCapable)
      return { kind: 'prompt', reason: { kind: 'store-only' }, nextCommand: syncCommand }
    return connected ? { kind: 'live', reason: 'forced' } : notConnected
  }

  if (!req.localCapable) {
    return connected
      ? { kind: 'prompt', reason: { kind: 'live-only' }, nextCommand: liveCommand(req) }
      : { ...notConnected, reason: { kind: 'not-connected', tables: [] } }
  }

  // A covered read answers from the Store, even while a sync runs.
  if (covered)
    return { kind: 'local' }

  if (runsForSite(syncRun, req.site))
    return { kind: 'syncing', done: syncRun.record.done, total: syncRun.record.planned }

  if (!stored) {
    if (!connected)
      return notConnected
    if (req.liveCapable)
      return { kind: 'live', reason: 'no-store-data' }
    return { kind: 'prompt', reason: { kind: 'no-data', tables }, nextCommand: syncCommand }
  }

  const windows = coverage.flatMap(need => need.kind === 'window' ? [need.window] : [])
  const gaps = coverage.flatMap(need => need.kind === 'window' ? need.gaps : [])
  const wanted = datesOf(windows)
  const missing = datesOf(gaps)
  return {
    kind: 'prompt',
    reason: { kind: 'partial', done: wanted.size - missing.size, total: wanted.size, missing: gaps },
    nextCommand: connected ? syncCommand : LOGIN_COMMAND,
  }
}

function siteLabel(site: string | undefined): string {
  return site ?? 'this Site'
}

/** The line that explains a stop. Pure. */
export function routeMessage(route: Exclude<Route, { kind: 'local' } | { kind: 'live' }>, req: RouteRequest, auth: RouteAuth): string {
  const site = siteLabel(req.site ?? req.siteHint)
  if (route.kind === 'syncing') {
    const live = req.liveCapable ? ', or pass --live' : ''
    return `Sync running: ${route.done.toLocaleString('en-US')} of ${route.total.toLocaleString('en-US')} days done. Run again when it finishes${live}.`
  }
  const next = route.nextCommand
  switch (route.reason.kind) {
    case 'not-connected': {
      const head = route.reason.tables.length > 0
        ? `The Store has no ${route.reason.tables.join(', ')} data for ${site}, and Google is not connected.`
        : `\`${req.label}\` needs Search Console, and Google is not connected.`
      return `${head} Run \`${next}\` to connect Google and sync the Site, or \`${LOGIN_COMMAND}\` to query Search Console directly.`
    }
    case 'no-data':
      return `The Store has no ${route.reason.tables.join(', ')} data for ${site}. \`${req.label}\` reads synced data only. Run \`${next}\` first.`
    case 'live-only':
      return `\`${req.label}\` runs against the live Search Console API only. Run \`${next}\`.`
    case 'store-only':
      return `\`${req.label}\` reads synced data only. Remove --live. If the Store has no data for ${site}, run \`${next}\` first.`
    case 'partial': {
      const { done, total } = route.reason
      const head = `The Store has ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} days for ${site}.`
      if (auth === 'none')
        return `${head} Run \`${next}\` to connect Google, then \`${syncCommandFor(req.site ?? req.siteHint, [])}\` to sync the rest.`
      const live = req.liveCapable ? ', or pass --live to ask Search Console directly' : ''
      return `${head} Run \`${next}\` to sync the rest${live}.`
    }
  }
}

/** The stderr note for an automatic live read. */
export function liveNote(site: string): string {
  return `No synced data for ${site}; answering from the live Search Console API.`
}

/** Machine-readable code of a stop, for `--json` output. */
export function stopCode(route: Exclude<Route, { kind: 'local' } | { kind: 'live' }>): string {
  if (route.kind === 'syncing')
    return 'SYNC_RUNNING'
  switch (route.reason.kind) {
    case 'not-connected': return 'NOT_CONNECTED'
    case 'no-data': return 'NO_SYNCED_DATA'
    case 'store-only': return 'STORE_ONLY'
    case 'live-only': return 'LIVE_ONLY'
    case 'partial': return 'STORE_RANGE_NOT_COVERED'
  }
}

// ---------------------------------------------------------------------------
// Effectful shell
// ---------------------------------------------------------------------------

export type RouteStop = Exclude<Route, { kind: 'local' } | { kind: 'live' }>

/** An Error that ends a command at a stop. The CLI shell prints its message and no stack. */
export function routeStopError(route: RouteStop, message: string): Error & { routeStop: RouteStop } {
  return Object.assign(new Error(message), { name: 'RouteStopError', routeStop: route })
}

export function routeStopOf(error: unknown): RouteStop | undefined {
  return (error as { routeStop?: RouteStop } | null)?.routeStop
}

/** Coverage of each need from the Store's sync states, through the engine's coverage plan. */
export async function needCoverage(needs: readonly RouteNeed[], states: readonly CoverageSyncState[]): Promise<NeedCoverage[]> {
  const reader = syncStateCoverageReader(states)
  const plans = new Map<string, Promise<CoveragePlan>>()
  const planFor = (searchType: SearchType, window: DateSpan, tables: readonly TableName[]): Promise<CoveragePlan> => {
    const key = `${searchType}|${window.start}|${window.end}`
    const plan = plans.get(key) ?? buildCoveragePlan({ searchType, requested: window, tables, reader })
    plans.set(key, plan)
    return plan
  }
  const windowed = needs.filter((need): need is Extract<RouteNeed, { kind: 'window' }> => need.kind === 'window')
  const tablesFor = (need: Extract<RouteNeed, { kind: 'window' }>): TableName[] =>
    [...new Set(windowed.filter(other => other.searchType === need.searchType && other.window.start === need.window.start && other.window.end === need.window.end).map(other => other.table))]

  return Promise.all(needs.map(async (need): Promise<NeedCoverage> => {
    if (need.kind === 'any') {
      const stored = need.tables.some(table => need.searchType
        ? hasSyncedDays(states, table, need.searchType)
        : states.some(state => state.table === table && state.state === 'done'))
      return { ...need, stored }
    }
    const plan = await planFor(need.searchType, need.window, tablesFor(need))
    const table = plan.tables.find(entry => entry.table === need.table)
    return {
      ...need,
      stored: hasSyncedDays(states, need.table, need.searchType),
      gaps: table ? table.gaps : gapsForRange([], need.window),
    }
  }))
}

/** Read the route inputs for a Site: auth, Store coverage and the sync-run record. */
export async function readRouteState(input: {
  store: LocalStore
  site: string | undefined
  needs: readonly RouteNeed[]
  /** Sync states already read by the caller, to avoid a second read. */
  states?: readonly CoverageSyncState[]
  /** Auth already probed by the caller. */
  auth?: RouteAuth
  now?: number
}): Promise<RouteState> {
  const { store, site } = input
  const states = input.states ?? await readSiteStates(store, site)
  const [auth, record] = await Promise.all([input.auth ?? probeAuth(), readSyncRun(store.dataDir)])
  return {
    auth,
    coverage: await needCoverage(input.needs, states),
    syncRun: syncRunStatus(record, { now: input.now ?? Date.now(), isAlive: isProcessAlive }),
  }
}

/** Sync states of one Site, or of every Site. An unknown Site has none. */
export async function readSiteStates(store: LocalStore, site: string | undefined): Promise<SyncState[]> {
  return store.engine.getSyncStates({ userId: store.userId, ...(site ? { siteId: store.siteIdFor(site) } : {}) })
}

/**
 * The Site a read targets. Store Sites come first and never call Google.
 * On a Store miss, a connected user resolves against the Search Console
 * account through `connect`. Without auth the Site stays undefined, and the
 * router asks the user to connect.
 */
export async function resolveReadSite(
  ctx: CommandContext,
  target: string | undefined,
  opts: { forceLive: boolean, connect: () => Promise<CommandContext> },
): Promise<{ site: string | undefined, siteHint?: string, auth: RouteAuth }> {
  const auth = await probeAuth()
  const connected = auth !== 'none'
  if (opts.forceLive && connected)
    return { site: await (await opts.connect()).resolveSite(target, { scope: 'account' }), auth }
  const hint = target?.trim() || ctx.config.defaultSite
  if (hint) {
    const found = await ctx.matchSite(hint, { scope: 'store' })
    if (found.kind === 'resolved')
      return { site: found.siteUrl, auth }
    if (found.kind !== 'not-found')
      throw new Error(formatSiteResolution(found, 'store'))
  }
  else if ((await listStoreSites(ctx.dataDir)).length > 0) {
    return { site: await ctx.resolveSite(undefined, { scope: 'store' }), auth }
  }
  if (!connected)
    return { site: undefined, ...(hint ? { siteHint: hint } : {}), auth }
  return { site: await (await opts.connect()).resolveSite(target, { scope: 'account' }), auth }
}

export interface RouteStopDetails {
  code: string
  message: string
  siteUrl: string | null
  nextCommand: string | null
  missingDates?: string[]
  sync?: { done: number, total: number }
}

export function describeStop(route: RouteStop, req: RouteRequest, auth: RouteAuth): RouteStopDetails {
  const message = routeMessage(route, req, auth)
  return {
    code: stopCode(route),
    message,
    siteUrl: req.site ?? req.siteHint ?? null,
    nextCommand: route.kind === 'prompt' ? route.nextCommand : null,
    ...(route.kind === 'prompt' && route.reason.kind === 'partial' ? { missingDates: [...datesOf(route.reason.missing)].sort() } : {}),
    ...(route.kind === 'syncing' ? { sync: { done: route.done, total: route.total } } : {}),
  }
}

/**
 * End the command at a stop. With `--json`, stdout gets `{ error }` so an
 * agent can read the next command. The shell prints the message to stderr.
 */
export function stopAtRoute(route: RouteStop, req: RouteRequest, auth: RouteAuth, opts: { json: boolean }): never {
  const details = describeStop(route, req, auth)
  if (opts.json)
    console.log(JSON.stringify({ error: details }, null, 2))
  throw routeStopError(route, details.message)
}
