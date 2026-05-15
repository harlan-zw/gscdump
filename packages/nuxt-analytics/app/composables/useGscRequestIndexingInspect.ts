import type { IndexingInspectRateLimited, IndexingInspectResponse } from '@gscdump/contracts'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export function useGscRequestIndexingInspect(): (
  siteId: string,
  urls: string[],
) => Promise<IndexingInspectResponse | IndexingInspectRateLimited> {
  const client = useGscAnalyticsClient()
  return async (siteId, urls) => {
    return client.requestIndexingInspect(siteId, { urls }).catch((err: unknown) => {
      const status = (err as { status?: number, statusCode?: number, response?: { status?: number } })?.status
        ?? (err as { statusCode?: number })?.statusCode
        ?? (err as { response?: { status?: number } })?.response?.status
      const data = (err as { data?: unknown })?.data as IndexingInspectRateLimited | undefined
      if (status === 429 && data && data.error === 'rate_limited')
        return data
      throw err
    })
  }
}
