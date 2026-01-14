import type { DateRange } from '@gscdump/db'
import type { CreateProviderOptions, DataProvider } from './types'
import { getSiteByProperty, hasDataForRange } from '@gscdump/db'
import { createApiProvider } from './api-provider'
import { createDbProvider } from './db-provider'

function toDateRange(period: { start: Date | string, end: Date | string }): DateRange {
  return {
    startDate: typeof period.start === 'string' ? period.start : period.start.toISOString().split('T')[0],
    endDate: typeof period.end === 'string' ? period.end : period.end.toISOString().split('T')[0],
  }
}

export async function createProvider(opts: CreateProviderOptions): Promise<DataProvider> {
  const { auth, db, source, siteUrls, range } = opts

  // Force API
  if (source === 'api' || !db)
    return createApiProvider(auth)

  // Build siteId map for DB lookups
  const siteIdMap = new Map<string, number>()
  for (const siteUrl of siteUrls) {
    const site = await getSiteByProperty(db, siteUrl)
    if (site?.siteId)
      siteIdMap.set(siteUrl, site.siteId)
  }

  // Force DB - error if sites not found
  if (source === 'db') {
    const missing = siteUrls.filter(url => !siteIdMap.has(url))
    if (missing.length > 0)
      throw new Error(`Sites not found in database: ${missing.join(', ')}. Run 'gscdump sync' first.`)
    return createDbProvider(db, siteIdMap)
  }

  // Auto mode - check if all sites have data for the range
  const dateRange = toDateRange(range.period)
  let allHaveData = siteIdMap.size === siteUrls.length

  if (allHaveData) {
    for (const [, siteId] of siteIdMap) {
      const hasData = await hasDataForRange(db, siteId, dateRange)
      if (!hasData) {
        allHaveData = false
        break
      }
    }
  }

  if (allHaveData)
    return createDbProvider(db, siteIdMap)

  return createApiProvider(auth)
}
