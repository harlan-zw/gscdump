import type { NeedCoverage, Route, RouteRequest, RouteState } from '../src/route'
import type { SyncRunStatus } from '../src/sync-run'
import { describe, expect, it } from 'vitest'
import { decideRoute } from '../src/route'

const SITE = 'sc-domain:example.com'
const WINDOW = { start: '2026-08-01', end: '2026-08-03' }

const covered: NeedCoverage = { kind: 'window', period: 'current', table: 'pages', searchType: 'web', window: WINDOW, stored: true, gaps: [] }
const partial: NeedCoverage = { ...covered, gaps: [{ start: '2026-08-02', end: '2026-08-02' }] }
const empty: NeedCoverage = { ...covered, stored: false, gaps: [WINDOW] }

const record = { pid: 1, startedAt: 0, heartbeatAt: 0, sites: [SITE], planned: 90, done: 41 }
const running: SyncRunStatus = { kind: 'running', record }
const otherSite: SyncRunStatus = { kind: 'running', record: { ...record, sites: ['sc-domain:other.com'] } }
const stale: SyncRunStatus = { kind: 'stale', record, reason: 'no-heartbeat' }
const none: SyncRunStatus = { kind: 'none' }

const request: RouteRequest = { site: SITE, label: 'query', localCapable: true, liveCapable: true, forceLive: false, argv: ['query', '--site', 'example.com'] }
const sync = 'gscdump sync --site example.com --start 2026-08-02 --end 2026-08-02 --tables pages'

describe('decideRoute', () => {
  it.each<[string, Partial<RouteRequest>, Partial<RouteState>, Route]>([
    ['answers a covered read from the Store', {}, { coverage: [covered] }, { kind: 'local' }],
    ['answers a covered read from the Store while a sync runs', {}, { coverage: [covered], syncRun: running }, { kind: 'local' }],
    ['answers a covered read from the Store without auth', {}, { auth: 'none', coverage: [covered] }, { kind: 'local' }],
    ['goes live when the Site has no Store data', {}, { coverage: [empty] }, { kind: 'live', reason: 'no-store-data' }],
    ['goes live through hosted auth when the Site has no Store data', {}, { auth: 'hosted', coverage: [empty] }, { kind: 'live', reason: 'no-store-data' }],
    ['asks to connect when nothing is synced and nothing is connected', {}, { auth: 'none', coverage: [empty] }, { kind: 'prompt', reason: { kind: 'not-connected', tables: ['pages'] }, nextCommand: 'gscdump init' }],
    ['asks to sync the missing days of partial coverage', {}, { coverage: [partial] }, { kind: 'prompt', reason: { kind: 'partial', done: 2, total: 3, missing: partial.gaps, windows: [{ period: 'current', table: 'pages', window: WINDOW, missing: partial.gaps }] }, nextCommand: sync }],
    ['asks to log in first when partial coverage has no auth', {}, { auth: 'none', coverage: [partial] }, { kind: 'prompt', reason: { kind: 'partial', done: 2, total: 3, missing: partial.gaps, windows: [{ period: 'current', table: 'pages', window: WINDOW, missing: partial.gaps }] }, nextCommand: 'gscdump auth login' }],
    ['never mixes sources when one table is synced and another is not', {}, { coverage: [covered, { ...empty, table: 'queries' }] }, { kind: 'prompt', reason: { kind: 'partial', done: 3, total: 3, missing: [WINDOW], windows: [{ period: 'current', table: 'queries', window: WINDOW, missing: [WINDOW] }] }, nextCommand: 'gscdump sync --site example.com --start 2026-08-01 --end 2026-08-03 --tables queries' }],
    ['shows sync progress when a sync for the Site runs and the range is not covered', {}, { coverage: [partial], syncRun: running }, { kind: 'syncing', done: 41, total: 90 }],
    ['shows sync progress instead of going live during a first sync', {}, { coverage: [empty], syncRun: running }, { kind: 'syncing', done: 41, total: 90 }],
    ['ignores a sync that runs for another Site', {}, { coverage: [empty], syncRun: otherSite }, { kind: 'live', reason: 'no-store-data' }],
    ['treats a stale sync as not running', {}, { coverage: [partial], syncRun: stale }, { kind: 'prompt', reason: { kind: 'partial', done: 2, total: 3, missing: partial.gaps, windows: [{ period: 'current', table: 'pages', window: WINDOW, missing: partial.gaps }] }, nextCommand: sync }],
    ['goes live when --live is passed, even with Store data', { forceLive: true }, { coverage: [covered] }, { kind: 'live', reason: 'forced' }],
    ['asks to connect when --live is passed without auth', { forceLive: true }, { auth: 'none', coverage: [covered] }, { kind: 'prompt', reason: { kind: 'not-connected', tables: ['pages'] }, nextCommand: 'gscdump init' }],
    ['refuses --live for a Store-only read', { forceLive: true, liveCapable: false }, { coverage: [covered] }, { kind: 'prompt', reason: { kind: 'store-only' }, nextCommand: 'gscdump sync --site example.com' }],
    ['asks to sync a Store-only read with no data', { liveCapable: false }, { coverage: [empty] }, { kind: 'prompt', reason: { kind: 'no-data', tables: ['pages'] }, nextCommand: 'gscdump sync --site example.com --start 2026-08-01 --end 2026-08-03 --tables pages' }],
    ['spells out --live for a live-only read', { localCapable: false }, { coverage: [] }, { kind: 'prompt', reason: { kind: 'live-only' }, nextCommand: 'gscdump query --site example.com --live' }],
    ['asks to connect for a live-only read without auth', { localCapable: false }, { auth: 'none', coverage: [] }, { kind: 'prompt', reason: { kind: 'not-connected', tables: [] }, nextCommand: 'gscdump init' }],
    ['answers raw SQL from the Store when a named table has data', { liveCapable: false }, { coverage: [{ kind: 'any', tables: ['pages', 'countries'], stored: true }] }, { kind: 'local' }],
    ['asks to sync raw SQL when no named table has data', { liveCapable: false }, { coverage: [{ kind: 'any', tables: ['countries'], stored: false }] }, { kind: 'prompt', reason: { kind: 'no-data', tables: ['countries'] }, nextCommand: 'gscdump sync --site example.com --tables countries' }],
    ['names the non-web search type in the sync command', {}, { coverage: [{ ...partial, searchType: 'image' }] }, { kind: 'prompt', reason: { kind: 'partial', done: 2, total: 3, missing: partial.gaps, windows: [{ period: 'current', table: 'pages', window: WINDOW, missing: partial.gaps }] }, nextCommand: `${sync} --types image` }],
  ])('%s', (_name, req, state, expected) => {
    expect(decideRoute({ ...request, ...req }, { auth: 'google', coverage: [], syncRun: none, ...state })).toEqual(expected)
  })
})
