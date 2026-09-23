import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalysisQuerySource } from '@gscdump/engine/source'
import type { Result } from 'gscdump/result'
import type { LocalStore, TableName } from './local-store'
import type { CoverageGap, WindowRead } from './window'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { AnalyzerCapabilityError, runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createEngineQuerySource } from '@gscdump/engine/source'
import { err, ok, unwrapResult } from 'gscdump/result'
import { decodeSiteId, normalizeSiteUrl } from 'gscdump/tenant'
import { createCommandContext } from './context'
import { LocalStoreUnsupportedError } from './error-handler'
import { createLocalStore } from './local-store'
import { logger } from './utils'
import { resolveAnchor, windowCoverage } from './window'

export async function hasLocalData(
  store: LocalStore,
  siteUrl: string,
): Promise<boolean> {
  const entries = await store.engine.listLive({
    userId: store.userId,
    siteId: store.siteIdFor(siteUrl),
  })
  return entries.length > 0
}

export interface ResolvedAnalysisSource {
  source: AnalysisQuerySource
  siteUrl: string
  format: string
  isLive: boolean
  /**
   * Run a single analysis through this resolved source. Translates
   * `AnalyzerCapabilityError` from the dispatcher into
   * `LocalStoreUnsupportedError` carrying the mode; the CLI shell renders it.
   */
  runAnalysis: (params: AnalysisParams) => Promise<AnalysisResult>
  /**
   * Newest complete date for `tables`: the Store's newest synced day in
   * local mode, `getLatestGscDate()` in live mode. Windows end on it.
   */
  anchorFor: (tables: readonly TableName[]) => Promise<string>
  /**
   * Check that the Store holds a `done` sync state for every day of every
   * read. Local runs must stop on `gaps`: partial data gives wrong numbers.
   * Live sources are always `covered`: the GSC API serves the whole window.
   */
  checkCoverage: (reads: readonly WindowRead[]) => Promise<CoverageCheck>
}

/**
 * Tables an analyzer's SQL plan reads, for anchoring its window. Dates in
 * `params` do not change the tables. Returns an empty list (any table) when
 * the analyzer has no SQL plan or its plan cannot build from these params;
 * the run itself then reports that build failure.
 */
export function analyzerTables(params: AnalysisParams): TableName[] {
  const analyzer = defaultAnalyzerRegistry.getAnalyzerVariants(params.type)?.sql
  if (!analyzer)
    return []
  let plan: ReturnType<typeof analyzer.build>
  try {
    plan = analyzer.build({ startDate: '2000-01-01', endDate: '2000-01-01', prevStartDate: '2000-01-01', prevEndDate: '2000-01-01', ...params })
  }
  catch (error) {
    logger.debug(`Cannot plan ${params.type} to pick its tables: ${(error as Error).message}`)
    return []
  }
  if (plan.kind !== 'sql')
    return []
  const fileSets = [plan.current, plan.previous, ...Object.values(plan.extraFiles ?? {})]
  return [...new Set(fileSets.flatMap(fileSet => fileSet ? [fileSet.table] : []))]
}

export type CoverageCheck
  = | { kind: 'covered' }
    | { kind: 'gaps', gaps: CoverageGap[], message: string }

/**
 * Tables and windows an analyzer's SQL plan reads for these dated params.
 * `current` and extra FileSets read the current window; `previous` reads the
 * comparison window. Returns an empty list when the analyzer has no SQL plan
 * or its plan cannot build; the run itself then reports that failure.
 */
export function analyzerReads(params: AnalysisParams): WindowRead[] {
  const analyzer = defaultAnalyzerRegistry.getAnalyzerVariants(params.type)?.sql
  if (!analyzer || !params.startDate || !params.endDate)
    return []
  let plan: ReturnType<typeof analyzer.build>
  try {
    plan = analyzer.build(params)
  }
  catch (error) {
    logger.debug(`Cannot plan ${params.type} to check its sync coverage: ${(error as Error).message}`)
    return []
  }
  if (plan.kind !== 'sql')
    return []
  const current = { window: 'current', start: params.startDate, end: params.endDate } as const
  const reads: WindowRead[] = [plan.current, ...Object.values(plan.extraFiles ?? {})].map(fileSet => ({ ...current, table: fileSet.table }))
  if (plan.previous && params.prevStartDate && params.prevEndDate)
    reads.push({ window: 'comparison', table: plan.previous.table, start: params.prevStartDate, end: params.prevEndDate })
  return reads
}

/** Stop message for sync gaps: each gap, then one sync command that fills them all. */
export function coverageGapMessage(siteUrl: string, gaps: readonly CoverageGap[]): string {
  const lines = gaps.map(gap => `  ${gap.window} window ${gap.start} to ${gap.end}: ${gap.table} misses ${gap.missingDays} of ${gap.expectedDays} days (${gap.missingStart} to ${gap.missingEnd}).`)
  const start = gaps.reduce((min, gap) => gap.missingStart < min ? gap.missingStart : min, gaps[0]!.missingStart)
  const end = gaps.reduce((max, gap) => gap.missingEnd > max ? gap.missingEnd : max, gaps[0]!.missingEnd)
  const tables = [...new Set(gaps.map(gap => gap.table))].sort().join(',')
  return [
    `The local Store for ${siteUrl} does not hold every day this run reads:`,
    ...lines,
    'Results from partial data are wrong, so the run stops.',
    `Run \`gscdump sync --site ${siteUrl} --start ${start} --end ${end} --tables ${tables}\`, or pass --live.`,
  ].join('\n')
}

function warnMissingSync(siteUrl: string) {
  return (tables: readonly TableName[], fallback: string): void => {
    logger.warn(`No synced days for ${tables.length ? tables.join(', ') : 'any table'} on ${siteUrl}. Windows end on ${fallback}. Run \`gscdump sync\` first.`)
  }
}

export interface ResolveAnalysisSourceArgs {
  site?: unknown
  live?: boolean
  json?: boolean
  format?: unknown
}

/**
 * List sites that have data in the local store, by scanning the on-disk
 * tenant directory (`<dataDir>/u_<userId>/<siteId>/`). Best-effort: only
 * returns shapes `decodeSiteId` round-trips (`d_*` and `h_*` prefixes,
 * which is everything GSC hands out in practice).
 */
export async function listLocalSites(
  dataDir: string,
  userId = 'local',
): Promise<string[]> {
  const tenantDir = join(dataDir, `u_${userId}`)
  return readdir(tenantDir, { withFileTypes: true })
    .then(entries => entries
      .filter(e => e.isDirectory() && (e.name.startsWith('d_') || e.name.startsWith('h_')))
      .map(e => decodeSiteId(e.name)))
    .catch(() => [])
}

function pickLocalSite(siteUrls: readonly string[], hint: string | undefined): string | null {
  if (siteUrls.length === 0)
    return null
  if (!hint)
    return siteUrls.length === 1 ? siteUrls[0]! : null
  const normalized = normalizeSiteUrl(hint)
  const exact = siteUrls.find(s => s === normalized || s === hint)
  if (exact)
    return exact
  const partial = siteUrls.find(s => s.includes(hint) || hint.includes(s))
  return partial ?? null
}

/**
 * Errors-as-values core: run one analysis, returning the modelled
 * `LocalStoreUnsupportedError` as a value when the dispatcher reports the
 * analyzer has no implementation for this source (`AnalyzerCapabilityError`).
 * Any other failure is a defect and still propagates. `makeRunAnalysis` is the
 * thin throwing wrapper that re-raises the value, preserving the
 * `LocalStoreUnsupportedError` identity the global handler matches on.
 */
async function runAnalysisResult(
  source: AnalysisQuerySource,
  params: AnalysisParams,
  mode: 'live' | 'local',
): Promise<Result<AnalysisResult, LocalStoreUnsupportedError>> {
  return runAnalyzerFromSource(source, params, defaultAnalyzerRegistry)
    .then(ok<AnalysisResult>)
    .catch((e: Error) => {
      if (e instanceof AnalyzerCapabilityError)
        return err(new LocalStoreUnsupportedError(params.type, mode))
      throw e
    })
}

function makeRunAnalysis(
  source: AnalysisQuerySource,
  mode: 'live' | 'local',
): (params: AnalysisParams) => Promise<AnalysisResult> {
  return async params =>
    unwrapResult(await runAnalysisResult(source, params, mode), e => e)
}

/**
 * Single entry point used by `analyze` and `report` commands. Picks live vs.
 * local-store source from `--live`, ensures local data exists when running
 * locally, and returns a `runAnalysis` shim that maps capability errors to
 * `LocalStoreUnsupportedError`. The CLI shell renders the final error.
 *
 * Local mode does NOT require live auth: the local store is the
 * authoritative source by design. Site resolution falls back to scanning
 * the on-disk tenant directory when no GSC client is available.
 */
export async function resolveAnalysisSource(
  args: ResolveAnalysisSourceArgs,
): Promise<ResolvedAnalysisSource> {
  const isLive = !!args.live
  const format = args.json ? 'json' : (args.format ? String(args.format) : 'table')

  if (!isLive) {
    const { config, dataDir } = await createCommandContext()
    const store = createLocalStore({ dataDir })
    const siteHint = args.site ? String(args.site) : config.defaultSite

    const localSites = await listLocalSites(dataDir, store.userId)
    const siteUrl = pickLocalSite(localSites, siteHint)
    if (!siteUrl) {
      if (localSites.length === 0)
        logger.error(`No local data found in ${dataDir}. Run \`gscdump sync\` first, or pass --live.`)
      else
        logger.error(`Could not resolve site${siteHint ? ` from "${siteHint}"` : ''}. Local sites: ${localSites.join(', ')}`)
      process.exit(1)
    }

    const localAvailable = await hasLocalData(store, siteUrl).catch(() => false)
    if (!localAvailable) {
      logger.error(`No local data for ${siteUrl}. Run \`gscdump sync\` first, or pass --live.`)
      process.exit(1)
    }
    const source = createEngineQuerySource({
      engine: store.engine,
      ctx: { userId: store.userId, siteId: store.siteIdFor(siteUrl) },
    })
    return {
      source,
      siteUrl,
      format,
      isLive,
      runAnalysis: makeRunAnalysis(source, 'local'),
      anchorFor: tables => resolveAnchor({ kind: 'local', store, siteUrl, tables }, warnMissingSync(siteUrl)),
      checkCoverage: async (reads) => {
        const states = await store.engine.getSyncStates({ userId: store.userId, siteId: store.siteIdFor(siteUrl), state: 'done' })
        const coverage = windowCoverage(states, reads)
        return coverage.kind === 'covered' ? coverage : { ...coverage, message: coverageGapMessage(siteUrl, coverage.gaps) }
      },
    }
  }

  const ctx = await createCommandContext({ needsAuth: true, needsStore: false })
  const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
  const source = createGscApiQuerySource({ client: ctx.client!, siteUrl })
  return {
    source,
    siteUrl,
    format,
    isLive,
    runAnalysis: makeRunAnalysis(source, 'live'),
    anchorFor: () => resolveAnchor({ kind: 'live' }, warnMissingSync(siteUrl)),
    checkCoverage: async () => ({ kind: 'covered' }),
  }
}
