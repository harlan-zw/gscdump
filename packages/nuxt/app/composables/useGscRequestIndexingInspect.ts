import type { IndexingInspectRateLimited, IndexingInspectResponse } from '@gscdump/contracts'
import { invalidateNuxtQueries } from 'nuxt-use-query/query-cache'
import { gscQueries } from '../queries/gsc'
import { useGscRpc } from '../utils/gsc-rpc'

export function useGscRequestIndexingInspect(): (
  siteId: string,
  urls: string[],
) => Promise<IndexingInspectResponse | IndexingInspectRateLimited> {
  const rpc = useGscRpc()
  return async (siteId, urls) => {
    return rpc.execute(gscQueries.indexingInspect(siteId), { urls }, { silent: true })
      .then((res) => {
        invalidateNuxtQueries(`gsc:inspections:${siteId}`)
        invalidateNuxtQueries(`gsc:inspection-history:${siteId}`)
        return res as IndexingInspectResponse | IndexingInspectRateLimited
      })
      .catch((err: unknown) => {
        const e = err as { type?: string, status?: number, statusCode?: number, response?: { status?: number }, data?: unknown }
        const status = e.status
          ?? e.statusCode
          ?? e.response?.status
        const data = e.data as IndexingInspectRateLimited | undefined
        if (status === 429 && data && data.error === 'rate_limited')
          return data
        throw err
      })
  }
}
