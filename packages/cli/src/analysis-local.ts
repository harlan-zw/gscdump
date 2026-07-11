import type {
  AnalysisParams,
  AnalysisQuerySource,
  AnalysisResult,
} from '@gscdump/analysis'
import type { Result } from 'gscdump/result'
import type { LocalStore } from './local-store'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  AnalyzerCapabilityError,
  createEngineQuerySource,
  runAnalyzerFromSource,
} from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { err, ok, unwrapResult } from 'gscdump/result'
import { decodeSiteId, normalizeSiteUrl } from 'gscdump/tenant'
import { createCommandContext } from './context'
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
   * `LocalStoreUnsupportedError` carrying the mode; commands attach
   * `gscErrorHandler` to render + exit.
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
 * `LocalStoreUnsupportedError`. Commands chain `.catch(gscErrorHandler)` for
 * the final render + exit.
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
    return { source, siteUrl, format, isLive, runAnalysis: makeRunAnalysis(source, 'local') }
  }

  const ctx = await createCommandContext({ needsAuth: true, needsStore: false })
  const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
  const source = createGscApiQuerySource({ client: ctx.client!, siteUrl })
  return { source, siteUrl, format, isLive, runAnalysis: makeRunAnalysis(source, 'live') }
}
