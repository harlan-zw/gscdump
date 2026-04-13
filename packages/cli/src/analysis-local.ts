import type { AnalysisParams, AnalysisResult } from 'gscdump/driver'
import type { AnalyticsHarness } from './analytics'
import { AnalyzerUnsupportedError, analyzeWithDuckDB } from 'gscdump/analytics'

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
  harness: AnalyticsHarness,
  siteUrl: string,
): Promise<boolean> {
  const entries = await harness.manifestStore.listLive({
    userId: harness.userId,
    siteId: harness.siteIdFor(siteUrl),
  })
  return entries.length > 0
}

export async function runLocalAnalysis(
  harness: AnalyticsHarness,
  siteUrl: string,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  return analyzeWithDuckDB(
    {
      factory: harness.factory,
      dataSource: harness.dataSource,
      manifestStore: harness.manifestStore,
    },
    { userId: harness.userId, siteId: harness.siteIdFor(siteUrl) },
    params,
  ).catch((e: Error) => {
    if (e instanceof AnalyzerUnsupportedError)
      throw new LocalStoreUnsupportedError(params.type)
    throw e
  })
}
