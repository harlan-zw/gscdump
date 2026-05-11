// Paginated indexing-status rows for a site, with optional status/issue/search
// filters. Backed by gscdump.com `/api/sites/[siteId]/indexing/urls`.

import type { IndexingUrlsResponse, IndexingUrlStatus } from '@gscdump/contracts'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export type { IndexingUrlRow, IndexingUrlsResponse, IndexingUrlStatus } from '@gscdump/contracts'

export interface UseGscIndexingUrlsOptions {
  status?: MaybeRefOrGetter<IndexingUrlStatus | undefined>
  issue?: MaybeRefOrGetter<string | undefined>
  search?: MaybeRefOrGetter<string | undefined>
  limit?: MaybeRefOrGetter<number>
  offset?: MaybeRefOrGetter<number>
}

export interface UseGscIndexingUrlsReturn {
  data: Readonly<Ref<IndexingUrlsResponse | null>>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useGscIndexingUrls(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  options: UseGscIndexingUrlsOptions = {},
): UseGscIndexingUrlsReturn {
  const data = ref<IndexingUrlsResponse | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    if (!id) {
      data.value = null
      return
    }
    loading.value = true
    const query: Record<string, string | number> = {}
    const status = toValue(options.status)
    const issue = toValue(options.issue)
    const search = toValue(options.search)
    const limit = toValue(options.limit)
    const offset = toValue(options.offset)
    if (status)
      query.status = status
    if (issue)
      query.issue = issue
    if (search)
      query.search = search
    if (limit)
      query.limit = limit
    if (offset)
      query.offset = offset
    data.value = await useGscAnalyticsClient().getIndexingUrls(id, query).catch(() => null)
    loading.value = false
  }

  watch(
    [() => toValue(siteId), () => toValue(options.status), () => toValue(options.issue), () => toValue(options.search), () => toValue(options.limit), () => toValue(options.offset)],
    refresh,
    { immediate: true },
  )

  return {
    data: data as Readonly<typeof data>,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
  }
}
