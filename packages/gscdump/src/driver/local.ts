import type { AnalysisPeriod, ComparisonPeriod } from '../analysis/fetch'
import type { Auth } from '../core/client'
import type { GscDriver } from './driver'
import type {
  AnalysisParams,
  AnalysisResult,
  DriverInspectResult,
  DriverQueryParams,
  DriverQueryResult,
  DriverSite,
  DriverSitemap,
} from './types'
import { fetchBrandSegmentation, fetchClustering, fetchDecay, fetchKeywordConcentration, fetchMovers, fetchOpportunity, fetchPageConcentration, fetchSeasonality, fetchStrikingDistance } from '../analysis'
import { googleSearchConsole } from '../core/client'

function buildRawQueryBody(params: DriverQueryParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    startDate: params.startDate,
    endDate: params.endDate,
    rowLimit: params.rowLimit ?? 25000,
    startRow: params.startRow ?? 0,
  }
  if (params.dimensions?.length)
    body.dimensions = params.dimensions
  if (params.searchType)
    body.type = params.searchType
  if (params.filters?.length) {
    body.dimensionFilterGroups = [{
      filters: params.filters.map(f => ({
        dimension: f.dimension,
        operator: f.operator,
        expression: f.expression,
      })),
    }]
  }
  return body
}

export function createLocalDriver(options: { auth: Auth }): GscDriver {
  const client = googleSearchConsole(options.auth)

  return {
    mode: 'local' as const,

    async sites(): Promise<DriverSite[]> {
      const gscSites = await client.sites()
      return gscSites
        .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
        .map(s => ({
          siteUrl: s.siteUrl!,
          permissionLevel: s.permissionLevel || 'unknown',
        }))
    },

    async query(siteUrl: string, params: DriverQueryParams): Promise<DriverQueryResult> {
      const body = buildRawQueryBody(params)
      const dimensions = params.dimensions || []
      const rowLimit = params.rowLimit ?? 25000
      const allRows: Record<string, unknown>[] = []
      let startRow = params.startRow ?? 0

      // Paginate through results
      while (true) {
        const response = await client._rawQuery(siteUrl, { ...body, startRow, rowLimit } as any)
        const rows = (response.rows || []).map((row) => {
          const result: Record<string, unknown> = {
            clicks: row.clicks ?? 0,
            impressions: row.impressions ?? 0,
            ctr: row.ctr ?? 0,
            position: row.position ?? 0,
          }
          dimensions.forEach((dim, i) => {
            result[dim] = row.keys?.[i]
          })
          return result
        })
        allRows.push(...rows)
        if (rows.length < rowLimit)
          break
        startRow += rows.length
      }

      return {
        rows: allRows as any,
        meta: {
          siteUrl,
          dimensions,
          dateRange: { startDate: params.startDate, endDate: params.endDate },
          rowCount: allRows.length,
          hasMore: false,
        },
      }
    },

    async sitemaps(siteUrl: string): Promise<DriverSitemap[]> {
      const list = await client.sitemaps.list(siteUrl)
      return list.map(sm => ({
        path: sm.path!,
        type: sm.type || undefined,
        isPending: sm.isPending || false,
        errors: Number(sm.errors) || 0,
        warnings: Number(sm.warnings) || 0,
        lastDownloaded: sm.lastDownloaded || null,
      }))
    },

    async submitSitemap(siteUrl: string, feedpath: string) {
      await client.sitemaps.submit(siteUrl, feedpath)
      return { success: true }
    },

    async deleteSitemap(siteUrl: string, feedpath: string) {
      await client.sitemaps.delete(siteUrl, feedpath)
      return { success: true }
    },

    async inspect(siteUrl: string, url: string): Promise<DriverInspectResult> {
      const result = await client.inspect(siteUrl, url)
      const inspection = result?.inspectionResult
      const indexStatus = inspection?.indexStatusResult

      return {
        url,
        verdict: indexStatus?.verdict || null,
        coverageState: indexStatus?.coverageState || null,
        indexingState: indexStatus?.indexingState || null,
        lastCrawlTime: indexStatus?.lastCrawlTime || null,
        isIndexed: indexStatus?.verdict === 'PASS',
        raw: result,
      }
    },

    async analysis(siteUrl: string, params: AnalysisParams): Promise<AnalysisResult> {
      const period: AnalysisPeriod = {
        startDate: params.startDate || defaultStartDate(),
        endDate: params.endDate || defaultEndDate(),
      }

      const comparisonPeriod: ComparisonPeriod | undefined = params.prevStartDate && params.prevEndDate
        ? { current: period, previous: { startDate: params.prevStartDate, endDate: params.prevEndDate } }
        : undefined

      switch (params.type) {
        case 'striking-distance': {
          const results = await fetchStrikingDistance(client, siteUrl, period, {
            minPosition: params.minPosition,
            maxPosition: params.maxPosition,
            minImpressions: params.minImpressions,
            maxCtr: params.maxCtr,
          })
          return { results: results as any, meta: { tool: params.type, total: results.length } }
        }
        case 'opportunity': {
          const results = await fetchOpportunity(client, siteUrl, period, {
            minImpressions: params.minImpressions,
          })
          return { results: results as any, meta: { tool: params.type, total: results.length } }
        }
        case 'movers': {
          if (!comparisonPeriod)
            throw new Error('Movers analysis requires prevStartDate and prevEndDate')
          const results = await fetchMovers(client, siteUrl, comparisonPeriod, {
            changeThreshold: params.changeThreshold,
            minImpressions: params.minImpressions,
          })
          return {
            results: [
              ...results.rising.map(r => ({ ...r, direction: 'rising' })),
              ...results.declining.map(r => ({ ...r, direction: 'declining' })),
            ] as any,
            meta: { tool: params.type, rising: results.rising.length, declining: results.declining.length },
          }
        }
        case 'decay': {
          if (!comparisonPeriod)
            throw new Error('Decay analysis requires prevStartDate and prevEndDate')
          const results = await fetchDecay(client, siteUrl, comparisonPeriod, {
            minPreviousClicks: params.minPreviousClicks,
            threshold: params.threshold,
          })
          return { results: results as any, meta: { tool: params.type, total: results.length } }
        }
        case 'brand': {
          if (!params.brandTerms?.length)
            throw new Error('Brand analysis requires brandTerms')
          const results = await fetchBrandSegmentation(client, siteUrl, period, {
            brandTerms: params.brandTerms,
            minImpressions: params.minImpressions,
          })
          return {
            results: [
              ...results.brand.map(r => ({ ...r, segment: 'brand' })),
              ...results.nonBrand.map(r => ({ ...r, segment: 'non-brand' })),
            ] as any,
            meta: { tool: params.type, summary: results.summary },
          }
        }
        case 'clustering': {
          const results = await fetchClustering(client, siteUrl, period, {
            clusterBy: params.clusterBy,
            minClusterSize: params.minClusterSize,
            minImpressions: params.minImpressions,
          })
          return {
            results: results.clusters as any,
            meta: { tool: params.type, totalClusters: results.clusters.length },
          }
        }
        case 'concentration': {
          const dim = params.dimension || 'pages'
          const results = dim === 'pages'
            ? await fetchPageConcentration(client, siteUrl, period, { topN: params.topN })
            : await fetchKeywordConcentration(client, siteUrl, period, { topN: params.topN })
          return { results: [results as any], meta: { tool: params.type, dimension: dim } }
        }
        case 'seasonality': {
          const results = await fetchSeasonality(client, siteUrl, period, {
            metric: params.metric,
          })
          return {
            results: results.monthlyBreakdown as any,
            meta: { tool: params.type, strength: results.strength },
          }
        }
        case 'zero-click':
        case 'cannibalization':
          throw new Error(`${params.type} analysis is only available in cloud mode`)
        case 'trends':
          throw new Error(`trends analysis requires a local Parquet store (run \`gscdump sync\` first)`)
        default:
          throw new Error(`Unknown analysis type: ${params.type}`)
      }
    },
  }
}

function defaultEndDate(): string {
  return new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
}

function defaultStartDate(): string {
  return new Date(Date.now() - 31 * 86400000).toISOString().split('T')[0]
}
