import type {
  AnalysisParams,
  AnalysisResult,
} from '@gscdump/analysis'
import type { googleSearchConsole } from 'gscdump'
import type { LocalStore } from './local-store'
import {
  analyzeFromSource,
  AnalyzerCapabilityError,
  createEngineQuerySource,
  createGscApiQuerySource,
} from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'

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
