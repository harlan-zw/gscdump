// How much of a Site's Search Console data the Store holds. Sync fills the
// Store over many runs, inside Google's quotas, so partial coverage is normal
// progress. `sync --status`, the sync summary, and `dump` share this value
// and its one renderer.

import type { SearchType } from 'gscdump/query'
import type { LocalStore, TableName } from './local-store'
import type { QuotaLedgerState } from './quota-ledger'
import type { SyncWindow } from './sync-plan'
import type { SyncRunStatus } from './sync-run'
import { createSitemapListStore, createSitemapReadStore, parseSitemapFeedIdentity } from '@gscdump/engine/entities'
import { getDateRange, getLatestGscDate, getOldestGscDate, getPstDate } from 'gscdump/dates'
import { INSPECTION_QPD_PER_PROPERTY } from './inspection-record'
import { inspectionCandidates, loadInspectionState } from './local-entities'
import { quotaLedgerPath, quotaStatus, readLedgerState } from './quota-ledger'
import { datesForJob, FIRST_SYNC_DAYS, jobWindowStart } from './sync-plan'

export type DatasetCoverage
  = | { kind: 'empty' }
    | { kind: 'complete', done: number }
    | {
      kind: 'partial'
      done: number
      total: number
      pending: number
      failed: number
      /** Epoch ms when Google lets the next call through, if a quota blocks progress. */
      resumesAt?: number
      /** Runs of the current budget until the rest is covered. */
      etaRuns?: number
      /** Days until the rest is covered with one run a day. */
      etaDays?: number
    }

export interface AnalyticsCoverage {
  table: TableName
  searchType: SearchType
  from: string
  to: string
  coverage: DatasetCoverage
}

/** Days across every table: a day is done when every table that covers it has it. */
export interface AnalyticsDays {
  from: string
  to: string
  coverage: DatasetCoverage
}

export interface InspectionCoverage {
  coverage: DatasetCoverage
  /** URLs a run inspects at most. */
  perRun: number
}

export interface SitemapCoverage {
  coverage: DatasetCoverage
  urls: number
}

export interface StoreCoverage {
  site: string
  analytics: AnalyticsCoverage[]
  days: AnalyticsDays
  inspections: InspectionCoverage
  sitemaps: SitemapCoverage
  /** Epoch ms until which Google refuses Search Analytics calls. */
  analyticsBlockedUntil?: number
  run: SyncRunStatus
}

function partialOrComplete(done: number, total: number, failed: number, extra: Partial<Extract<DatasetCoverage, { kind: 'partial' }>> = {}): DatasetCoverage {
  if (total === 0)
    return { kind: 'empty' }
  if (done >= total && failed === 0)
    return { kind: 'complete', done }
  return { kind: 'partial', done, total, failed, pending: Math.max(0, total - done - failed), ...extra }
}

/**
 * Coverage of each (table, search type) that has sync states, plus the days
 * across all of them. The window is the one a plain `sync` catches up: the
 * table's oldest synced date (not older than Google's retention) to the
 * latest final date. A table is never judged against dates it never held.
 */
export function analyticsCoverage(input: {
  states: ReadonlyArray<{ table: TableName, searchType?: SearchType, date: string, state: string }>
  latest: string
  floor: string
  today: string
}): { jobs: AnalyticsCoverage[], days: AnalyticsDays } {
  const byJob = new Map<string, { table: TableName, searchType: SearchType, states: Array<{ date: string, state: string }> }>()
  for (const state of input.states) {
    const searchType = state.searchType ?? 'web'
    const key = `${state.table}|${searchType}`
    const job = byJob.get(key) ?? { table: state.table, searchType, states: [] }
    job.states.push({ date: state.date, state: state.state })
    byJob.set(key, job)
  }
  const jobs: AnalyticsCoverage[] = []
  const dayState = new Map<string, 'done' | 'pending' | 'failed'>()
  const window: SyncWindow = { kind: 'catch-up', firstStart: input.latest, floor: input.floor, end: input.latest }
  for (const job of byJob.values()) {
    const from = jobWindowStart(window, job.states)
    const dates = datesForJob(job.table, getDateRange(from, input.latest), input.today)
    const stateByDate = new Map(job.states.map(state => [state.date, state.state]))
    let done = 0
    let failed = 0
    for (const date of dates) {
      const state = stateByDate.get(date)
      const prior = dayState.get(date)
      if (state === 'done') {
        done++
        if (!prior)
          dayState.set(date, 'done')
      }
      else if (state === 'failed') {
        failed++
        dayState.set(date, 'failed')
      }
      else if (prior !== 'failed') {
        dayState.set(date, 'pending')
      }
    }
    jobs.push({ table: job.table, searchType: job.searchType, from: dates[0] ?? from, to: input.latest, coverage: partialOrComplete(done, dates.length, failed) })
  }
  jobs.sort((a, b) => a.table.localeCompare(b.table) || a.searchType.localeCompare(b.searchType))
  const sortedDays = [...dayState.keys()].sort()
  const values = [...dayState.values()]
  return {
    jobs,
    days: {
      from: sortedDays[0] ?? input.latest,
      to: input.latest,
      coverage: partialOrComplete(values.filter(v => v === 'done').length, values.length, values.filter(v => v === 'failed').length),
    },
  }
}

/** URLs with at least one inspection, out of every URL the Site knows about. */
export function inspectionCoverage(input: {
  candidates: readonly string[]
  /** URLs with at least one saved inspection. */
  inspected: ReadonlySet<string>
  perRun: number
  blockedUntil?: number
}): InspectionCoverage {
  const { inspected } = input
  const total = new Set(input.candidates).size
  const done = [...new Set(input.candidates)].filter(url => inspected.has(url)).length
  const pending = total - done
  const perRun = Math.max(0, Math.min(input.perRun, INSPECTION_QPD_PER_PROPERTY))
  const etaRuns = perRun > 0 ? Math.ceil(pending / perRun) : undefined
  return {
    perRun,
    coverage: partialOrComplete(done, total, 0, {
      ...(etaRuns !== undefined ? { etaRuns, etaDays: etaRuns } : {}),
      ...(input.blockedUntil !== undefined ? { resumesAt: input.blockedUntil } : {}),
    }),
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function plural(count: number, one: string, many: string): string {
  return `${n(count)} ${count === 1 ? one : many}`
}

function clock(at: number): string {
  return new Date(at).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })
}

/** The command that moves this Site forward. A plain sync also retries failed dates. */
export function nextCommand(coverage: StoreCoverage): string {
  if (coverage.run.kind === 'running')
    return `gscdump sync --status --site ${coverage.site}`
  return `gscdump sync --site ${coverage.site}`
}

function analyticsLine(coverage: StoreCoverage): string {
  const { from, to, coverage: c } = coverage.days
  if (c.kind === 'empty')
    return `Analytics: nothing synced yet. A first sync fetches the last ${FIRST_SYNC_DAYS} days.`
  if (c.kind === 'complete')
    return `Analytics: all ${plural(c.done, 'day', 'days')} from ${from} to ${to}, every table.`
  const failed = c.failed > 0 ? ` ${plural(c.failed, 'day has', 'days have')} a failed table.` : ''
  const next = coverage.analyticsBlockedUntil !== undefined
    ? ` Google paused Search Analytics calls until ${clock(coverage.analyticsBlockedUntil)}. The next sync after that continues.`
    : ' The next sync continues from there.'
  return `Analytics: ${n(c.done)} of ${plural(c.total, 'day', 'days')} so far (${from} to ${to}).${failed}${next}`
}

function inspectionLine(coverage: StoreCoverage): string {
  const { coverage: c, perRun } = coverage.inspections
  if (c.kind === 'empty')
    return 'Inspections: no URLs yet. Sync saves sitemaps and pages first.'
  if (c.kind === 'complete')
    return `Inspections: all ${plural(c.done, 'URL', 'URLs')} inspected at least once.`
  const head = `Inspections: ${n(c.done)} of ${plural(c.total, 'URL', 'URLs')} so far.`
  const blocked = c.resumesAt !== undefined ? ` Google allows more after ${clock(c.resumesAt)}.` : ''
  if (perRun === 0)
    return `${head}${blocked} Pass --inspect-limit to inspect URLs during sync.`
  const eta = c.etaRuns ?? 0
  if (perRun >= INSPECTION_QPD_PER_PROPERTY)
    return `${head}${blocked} Daily sync covers the rest in about ${plural(eta, 'day', 'days')} at ${n(perRun)} URLs a day.`
  const fastest = Math.ceil(c.pending / INSPECTION_QPD_PER_PROPERTY)
  const raise = fastest < eta
    ? ` Pass --inspect-limit ${n(INSPECTION_QPD_PER_PROPERTY).replace(',', '')} to finish in about ${plural(fastest, 'day', 'days')}.`
    : ''
  return `${head}${blocked} Daily sync covers the rest in about ${plural(eta, 'run', 'runs')} at ${n(perRun)} URLs a run.${raise}`
}

function sitemapLine(coverage: StoreCoverage): string {
  const { coverage: c, urls } = coverage.sitemaps
  if (c.kind === 'empty')
    return 'Sitemaps: none saved yet.'
  if (c.kind === 'complete')
    return `Sitemaps: all ${plural(c.done, 'sitemap', 'sitemaps')} saved, ${plural(urls, 'URL', 'URLs')}.`
  return `Sitemaps: ${n(c.done)} of ${plural(c.total, 'sitemap', 'sitemaps')} saved so far, ${plural(urls, 'URL', 'URLs')}. The next sync reads the rest.`
}

/** One line per dataset, then the next command. */
export function renderCoverage(coverage: StoreCoverage): string[] {
  const lines = [analyticsLine(coverage), inspectionLine(coverage), sitemapLine(coverage)]
  if (coverage.run.kind === 'running') {
    const { record } = coverage.run
    lines.unshift(`Sync running: ${n(record.done)}/${n(record.planned)} days, pid ${record.pid}.`)
  }
  else if (coverage.run.kind === 'stale') {
    const { record } = coverage.run
    lines.unshift(`The last sync stopped at ${n(record.done)}/${n(record.planned)} days without finishing (pid ${record.pid}). The next sync retries its dates.`)
  }
  lines.push(`Next: ${nextCommand(coverage)}`)
  return lines
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

async function sitemapCoverage(store: LocalStore, siteUrl: string): Promise<SitemapCoverage> {
  const ctx = { userId: store.userId, siteId: store.siteIdFor(siteUrl) }
  const list = await createSitemapListStore({ dataSource: store.dataSource }).load(ctx)
  if (!list)
    return { coverage: { kind: 'empty' }, urls: 0 }
  const feeds = new Set<string>()
  let urls = 0
  const iterated = await createSitemapReadStore({ dataSource: store.dataSource }).iterateSitemapGenerationUrls(ctx)
  if (iterated._tag === 'iterator') {
    for await (const record of iterated.items) {
      feeds.add(record.feedpath)
      urls++
    }
  }
  // A sitemap Google reports as empty has nothing to save.
  const expected = list.sitemaps.filter(sitemap => sitemap.contents.some(content => content.submitted > 0))
  const saved = expected.filter((sitemap) => {
    const identity = parseSitemapFeedIdentity(sitemap.path)
    return identity._tag === 'ok' && feeds.has(identity.url)
  }).length
  if (list.sitemaps.length === 0)
    return { coverage: { kind: 'complete', done: 0 }, urls }
  return { coverage: partialOrComplete(saved, expected.length, 0), urls }
}

/** Read a Site's coverage from the Store, the quota ledger, and the run record. */
export async function readStoreCoverage(input: {
  store: LocalStore
  site: string
  inspectLimit: number
  run: SyncRunStatus
  now?: Date
  ledger?: QuotaLedgerState
}): Promise<StoreCoverage> {
  const { store, site } = input
  const now = input.now ?? new Date()
  const ctx = { userId: store.userId, siteId: store.siteIdFor(site) }
  const ledger = input.ledger ?? await readLedgerState(quotaLedgerPath(store.dataDir))
  const states = await store.engine.getSyncStates(ctx)
  const { jobs: analytics, days } = analyticsCoverage({ states, latest: getLatestGscDate(), floor: getOldestGscDate(), today: getPstDate(now) })
  const inspectBlock = quotaStatus(ledger, { api: 'urlInspection', site, now }).blocked
  const analyticsBlock = quotaStatus(ledger, { api: 'searchAnalytics', site, now }).blocked
  const inspections = inspectionCoverage({
    candidates: await inspectionCandidates(store, site),
    // The index holds the newest record per URL, so its keys are every inspected URL.
    inspected: new Set((await loadInspectionState(store.dataSource, ctx, now)).latest.keys()),
    perRun: input.inspectLimit,
    ...(inspectBlock ? { blockedUntil: inspectBlock.until } : {}),
  })
  return {
    site,
    analytics,
    days,
    inspections,
    sitemaps: await sitemapCoverage(store, site),
    ...(analyticsBlock ? { analyticsBlockedUntil: analyticsBlock.until } : {}),
    run: input.run,
  }
}
