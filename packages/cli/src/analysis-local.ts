import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalysisQuerySource } from '@gscdump/engine/source'
import type { Result } from 'gscdump/result'
import type { LocalStore } from './local-store'
import process from 'node:process'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { AnalyzerCapabilityError, runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createEngineQuerySource } from '@gscdump/engine/source'
import { err, ok, unwrapResult } from 'gscdump/result'
import { createCommandContext, siteArg } from './context'
import { LocalStoreUnsupportedError } from './error-handler'
import { createLocalStore } from './local-store'
import { logger } from './utils'

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
}

export interface ResolveAnalysisSourceArgs {
  site?: unknown
  live?: boolean
  json?: boolean
  format?: unknown
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
 * authoritative source by design, and the Site resolves from the Store.
 */
export async function resolveAnalysisSource(
  args: ResolveAnalysisSourceArgs,
): Promise<ResolvedAnalysisSource> {
  const isLive = !!args.live
  const format = args.json ? 'json' : (args.format ? String(args.format) : 'table')

  if (!isLive) {
    const ctx = await createCommandContext()
    const store = createLocalStore({ dataDir: ctx.dataDir })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined, { scope: 'store' })

    const localAvailable = await hasLocalData(store, siteUrl)
    if (!localAvailable) {
      logger.error(`No local data for ${siteUrl}. Run \`gscdump sync --site ${siteArg(siteUrl)}\` first, or pass --live.`)
      process.exit(1)
    }
    const source = createEngineQuerySource({
      engine: store.engine,
      ctx: { userId: store.userId, siteId: store.siteIdFor(siteUrl) },
    })
    return { source, siteUrl, format, isLive, runAnalysis: makeRunAnalysis(source, 'local') }
  }

  const ctx = await createCommandContext({ needsAuth: true, needsStore: false })
  const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
  const source = createGscApiQuerySource({ client: ctx.client!, siteUrl })
  return { source, siteUrl, format, isLive, runAnalysis: makeRunAnalysis(source, 'live') }
}
