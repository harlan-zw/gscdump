import { createAnalyticsClient } from '@gscdump/sdk'
import type { AnalyticsClient, AnalyticsFetch } from '@gscdump/sdk'
import { getGscFetchHeaders, useGscFetch } from '../utils/gsc-fetch'
import { readGscAuth } from './useGscAuth'

export function useGscAnalyticsClient(): AnalyticsClient {
  const cfg = useRuntimeConfig().public.analytics as { apiBase?: string } | undefined
  return createAnalyticsClient({
    apiBase: readGscAuth().apiBase || cfg?.apiBase || '',
    fetch: useGscFetch() as unknown as AnalyticsFetch,
    headers: () => {
      const auth = readGscAuth()
      const headers = new Headers(getGscFetchHeaders())
      if (auth.apiKey)
        headers.set('x-api-key', auth.apiKey)
      return headers
    },
  })
}
