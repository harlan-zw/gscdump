import type {
  AnalysisParams,
  AnalysisQuerySource,
  AnalysisResult,
} from '@gscdump/analysis'
import type { googleSearchConsole } from 'gscdump'
import type { LocalStore } from './local-store'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  analyzeFromSource,
  AnalyzerCapabilityError,
  createEngineQuerySource,
} from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { decodeSiteId, normalizeSiteUrl } from 'gscdump/tenant'
import { loadConfig, resolveDataDir } from './config'
import { createCommandContext } from './context'
import { gscErrorHandler } from './error-handler'
import { createLocalStore } from './local-store'
import { logger } from './utils'

export class LocalStoreUnsupportedError extends Error {
  constructor(tool: string) {
    super(`analysis "${tool}" is not yet implemented against the local Parquet store`)
    this.name = 'LocalStoreUnsupportedError'
  }
}

export class LocalStoreEmptyError extends Error {
  constructor(siteUrl: string) {
    super(`no local data synced for ${siteUrl} (run \`gscdump sync\` first)`)
    this.name = 'LocalStoreEmptyError'
  }
}

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

export async function runLocalAnalysis(
  store: LocalStore,
  siteUrl: string,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const source = createEngineQuerySource({
    engine: store.engine,
    ctx: { userId: store.userId, siteId: store.siteIdFor(siteUrl) },
  })
  return analyzeFromSource(source, params, defaultAnalyzerRegistry).catch((e: Error) => {
    if (e instanceof AnalyzerCapabilityError)
      throw new LocalStoreUnsupportedError(params.type)
    throw e
  })
}

/**
 * Live mode: hand the GSC API source to the unified dispatcher in
 * `@gscdump/analysis`. Tools with no row-based implementation throw
 * `AnalyzerCapabilityError`; we translate that into
 * `LocalStoreUnsupportedError` so the CLI's "run sync first" message stays
 * put.
 */
export async function runLiveAnalysis(
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const source = createGscApiQuerySource({ client, siteUrl })
  return analyzeFromSource(source, params, defaultAnalyzerRegistry).catch((e: Error) => {
    if (e instanceof AnalyzerCapabilityError)
      throw new LocalStoreUnsupportedError(params.type)
    throw e
  })
}

export interface ResolvedAnalysisSource {
  source: AnalysisQuerySource
  siteUrl: string
  format: string
  isLive: boolean
  /**
   * Run a single analysis through this resolved source. Maps
   * `AnalyzerCapabilityError` to `LocalStoreUnsupportedError` when in local
   * mode and applies `gscErrorHandler` in live mode so callers get the same
   * error UX regardless of source.
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
 * Single entry point used by `analyze` and `report` commands. Picks live vs.
 * local-store source from `--live`, ensures local data exists when running
 * locally, and returns a `runAnalysis` shim that applies the same
 * error-mapping the CLI has always done.
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
    const config = await loadConfig()
    const dataDir = resolveDataDir(config)
    const store = createLocalStore({ dataDir })
    const siteHint = args.site ? String(args.site) : config.defaultSite

    const localSites = await listLocalSites(dataDir, store.userId)
    const siteUrl = pickLocalSite(localSites, siteHint)
    if (!siteUrl) {
      if (localSites.length === 0) {
        logger.error(`No local data found in ${dataDir}. Run \`gscdump sync\` first, or pass --live.`)
      }
      else {
        logger.error(`Could not resolve site${siteHint ? ` from "${siteHint}"` : ''}. Local sites: ${localSites.join(', ')}`)
      }
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
    const runAnalysis = (params: AnalysisParams): Promise<AnalysisResult> =>
      analyzeFromSource(source, params, defaultAnalyzerRegistry).catch((e: Error) => {
        if (e instanceof AnalyzerCapabilityError) {
          logger.error(`${new LocalStoreUnsupportedError(params.type).message}. Pass --live to run against the GSC API.`)
          process.exit(1)
        }
        logger.error(`Local analysis failed: ${e.message}`)
        process.exit(1)
      })
    return { source, siteUrl, format, isLive, runAnalysis }
  }

  const ctx = await createCommandContext({ needsAuth: true, needsStore: false })
  const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
  const source = createGscApiQuerySource({ client: ctx.client!, siteUrl })
  const runAnalysis = (params: AnalysisParams): Promise<AnalysisResult> =>
    analyzeFromSource(source, params, defaultAnalyzerRegistry).catch((e: Error) => {
      if (e instanceof AnalyzerCapabilityError)
        throw new LocalStoreUnsupportedError(params.type)
      return gscErrorHandler(e)
    })
  return { source, siteUrl, format, isLive, runAnalysis }
}
