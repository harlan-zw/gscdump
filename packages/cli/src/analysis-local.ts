import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalysisQuerySource, FileSet } from '@gscdump/engine/source'
import type { BuilderState } from 'gscdump/query'
import type { Result } from 'gscdump/result'
import type { TableName } from './local-store'
import type { LiveReason, RouteNeed } from './route'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { AnalyzerCapabilityError, runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createEngineQuerySource } from '@gscdump/engine/source'
import { getLatestGscDate } from 'gscdump/dates'
import { extractDateRange } from 'gscdump/query'
import { err, ok, unwrapResult } from 'gscdump/result'
import { createCommandContext } from './context'
import { LocalStoreUnsupportedError } from './error-handler'
import { inferTable } from './local-store'
import { decideRoute, liveNote, readRouteState, readSiteStates, resolveReadSite, stopAtRoute } from './route'
import { useCliRuntime } from './runtime'
import { logger } from './utils'
import { newestDoneDate } from './window'

/** Where the rows of a run came from. JSON output carries it as `meta.source`. */
export type RowSource = 'local' | 'live'

export interface ResolvedAnalysisSource {
  source: AnalysisQuerySource
  siteUrl: string
  isLive: boolean
  /** Set when the router chose live on its own or `--live` forced it. */
  liveReason?: LiveReason
  /** Newest complete date the window ends on. */
  anchor: string
  /**
   * Run a single analysis through this resolved source. Translates
   * `AnalyzerCapabilityError` from the dispatcher into
   * `LocalStoreUnsupportedError` carrying the mode; the CLI shell renders it.
   */
  runAnalysis: (params: AnalysisParams) => Promise<AnalysisResult>
}

const PLACEHOLDER_DATE = '2000-01-01'
const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2}-\d{2})$/

function sqlPlanFileSets(params: AnalysisParams): FileSet[] | undefined {
  const analyzer = defaultAnalyzerRegistry.getAnalyzerVariants(params.type)?.sql
  if (!analyzer)
    return undefined
  let plan: ReturnType<typeof analyzer.build>
  try {
    plan = analyzer.build(params)
  }
  catch (error) {
    // The run itself reports the build failure with its own message.
    logger.debug(`Cannot plan ${params.type}: ${(error as Error).message}`)
    return undefined
  }
  if (plan.kind !== 'sql')
    return undefined
  return [plan.current, plan.previous, ...Object.values(plan.extraFiles ?? {})].filter((fileSet): fileSet is FileSet => Boolean(fileSet))
}

/**
 * Tables an analyzer's SQL plan reads, for anchoring its window. Dates in
 * `params` do not change the tables. Returns an empty list (any table) when
 * the analyzer has no SQL plan or its plan cannot build from these params.
 */
export function analyzerTables(params: AnalysisParams): TableName[] {
  const fileSets = sqlPlanFileSets({ startDate: PLACEHOLDER_DATE, endDate: PLACEHOLDER_DATE, prevStartDate: PLACEHOLDER_DATE, prevEndDate: PLACEHOLDER_DATE, ...params })
  return [...new Set((fileSets ?? []).map(fileSet => fileSet.table))]
}

/** Whether the analyzer's SQL plan compiles through a BuildContext adapter. */
function isAdapterPlanned(type: string): boolean {
  return defaultAnalyzerRegistry.getAnalyzerVariants(type)?.sql?.requires.includes('adapter') ?? false
}

function isBuilderState(value: unknown): value is BuilderState {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { dimensions?: unknown }).dimensions)
}

/** The Store read of one BuilderState: its table, scoped to its own dates. */
function builderStateNeed(state: BuilderState): RouteNeed {
  const table = inferTable(state.dimensions)
  const { startDate, endDate } = extractDateRange(state.filter)
  const searchType = state.searchType && state.searchType !== 'web' ? state.searchType : undefined
  if (startDate && endDate)
    return { kind: 'window', table, searchType: searchType ?? 'web', window: { start: startDate, end: endDate } }
  return { kind: 'any', tables: [table], ...(searchType ? { searchType } : {}) }
}

/**
 * Store needs of the BuilderState-driven analyzers (`data-query`,
 * `data-detail`). Their SQL plan compiles only through a source adapter, so
 * routing reads the tables and dates off `params.q` / `params.qc` instead.
 * Without a `q` the run reads no known table, so the need stays unmet and
 * the router stops or answers live rather than assuming coverage.
 */
function builderStateNeeds(params: AnalysisParams): RouteNeed[] {
  if (!isAdapterPlanned(params.type))
    return []
  if (!isBuilderState(params.q))
    return [{ kind: 'any', tables: [] }]
  const needs = [builderStateNeed(params.q)]
  if (isBuilderState(params.qc))
    needs.push(builderStateNeed(params.qc))
  return needs
}

/**
 * What a run reads from the Store: each FileSet of the analyzer's SQL plan,
 * with the dates of its daily partitions. `params` must hold the real window.
 * A FileSet without daily partitions scopes its own rows, so any synced day
 * of its table counts. Plans that cannot build here (the BuilderState-driven
 * ones) fall back to `builderStateNeeds` — an unanalysed read must never
 * look covered, or the router sends an empty Store into the analyzer.
 */
export function analysisNeeds(params: AnalysisParams): RouteNeed[] {
  const needs: RouteNeed[] = []
  for (const fileSet of sqlPlanFileSets(params) ?? []) {
    const dates = fileSet.partitions.flatMap(partition => DAILY_PARTITION_RE.exec(partition)?.[1] ?? []).sort()
    if (dates.length === 0) {
      needs.push({ kind: 'any', tables: [fileSet.table] })
      continue
    }
    needs.push({ kind: 'window', table: fileSet.table, searchType: 'web', window: { start: dates[0]!, end: dates.at(-1)! } })
  }
  return needs.length > 0 ? needs : builderStateNeeds(params)
}

/** Which sources can run these analyzers. */
export function analyzerSources(types: readonly string[]): { local: boolean, live: boolean } {
  const variants = types.map(type => defaultAnalyzerRegistry.getAnalyzerVariants(type))
  return {
    local: variants.every(variant => Boolean(variant?.sql)),
    live: variants.every(variant => Boolean(variant?.rows)),
  }
}

export interface ResolveAnalysisSourceArgs {
  site?: unknown
  live?: boolean
  json?: boolean
  /** The command, for messages: `analyze movers`, `report triage`. */
  label: string
  /** Analyzer ids the run executes. They decide which sources can answer. */
  types: readonly string[]
  /** Which sources can answer, when `types` alone does not say. */
  sources?: { local: boolean, live: boolean }
  /** Tables whose newest synced day anchors the window. */
  anchorTables: readonly TableName[]
  /** Store needs of the run once its window ends on `anchor`. */
  needs: (anchor: string) => RouteNeed[]
}

/**
 * Errors-as-values core: run one analysis, returning the modelled
 * `LocalStoreUnsupportedError` as a value when the dispatcher reports the
 * analyzer has no implementation for this source (`AnalyzerCapabilityError`).
 * Any other failure is a defect and still propagates.
 */
async function runAnalysisResult(
  source: AnalysisQuerySource,
  params: AnalysisParams,
  mode: RowSource,
): Promise<Result<AnalysisResult, LocalStoreUnsupportedError>> {
  return runAnalyzerFromSource(source, params, defaultAnalyzerRegistry)
    .then(ok<AnalysisResult>)
    .catch((e: Error) => {
      if (e instanceof AnalyzerCapabilityError)
        return err(new LocalStoreUnsupportedError(params.type, mode))
      throw e
    })
}

function makeRunAnalysis(source: AnalysisQuerySource, mode: RowSource): (params: AnalysisParams) => Promise<AnalysisResult> {
  return async (params) => {
    const result = unwrapResult(await runAnalysisResult(source, params, mode), e => e)
    return { ...result, meta: { ...result.meta, source: mode } }
  }
}

/**
 * Single entry point for `analyze` and `report`. The router picks the
 * Store or the live API from coverage, auth and the sync run, and stops
 * with the next command when neither can answer. A Store read never needs
 * Google auth.
 */
export async function resolveAnalysisSource(args: ResolveAnalysisSourceArgs): Promise<ResolvedAnalysisSource> {
  const forceLive = Boolean(args.live)
  const ctx = await createCommandContext({ needsStore: true })
  const store = ctx.store!
  let live: ReturnType<typeof createCommandContext> | undefined
  const connect = (): ReturnType<typeof createCommandContext> => (live ??= createCommandContext({ needsAuth: true, needsStore: false }))
  const { site, siteHint, auth } = await resolveReadSite(ctx, args.site ? String(args.site) : undefined, { forceLive, connect })

  const states = site ? await readSiteStates(store, site) : []
  const anchor = forceLive ? getLatestGscDate() : newestDoneDate(states, args.anchorTables) ?? getLatestGscDate()
  const sources = args.sources ?? analyzerSources(args.types)
  const req = { site, siteHint, label: args.label, localCapable: sources.local, liveCapable: sources.live, forceLive, argv: useCliRuntime().rawArgs }
  const state = await readRouteState({ store, site, needs: args.needs(anchor), states, auth })
  const route = decideRoute(req, state)

  if (route.kind === 'syncing' || route.kind === 'prompt')
    stopAtRoute(route, req, state.auth, { json: Boolean(args.json) })

  if (route.kind === 'local') {
    const source = createEngineQuerySource({ engine: store.engine, ctx: { userId: store.userId, siteId: store.siteIdFor(site!) } })
    return { source, siteUrl: site!, isLive: false, anchor, runAnalysis: makeRunAnalysis(source, 'local') }
  }

  const liveCtx = await connect()
  const siteUrl = site ?? await liveCtx.resolveSite(undefined)
  if (route.reason === 'no-store-data')
    logger.warn(liveNote(siteUrl))
  const source = createGscApiQuerySource({ client: liveCtx.client!, siteUrl })
  return { source, siteUrl, isLive: true, liveReason: route.reason, anchor, runAnalysis: makeRunAnalysis(source, 'live') }
}
