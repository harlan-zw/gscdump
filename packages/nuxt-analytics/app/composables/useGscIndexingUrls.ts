// Paginated indexing-status rows for a site, with optional status/issue/search
// filters. Backed by gscdump.com `/api/sites/[siteId]/indexing/urls`.

import { useGscFetch } from '../utils/gsc-fetch'

export type IndexingUrlStatus = 'indexed' | 'not_indexed' | 'pending'

export interface IndexingUrlRow {
  url: string
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  robotsTxtState: string | null
  pageFetchState: string | null
  lastCrawlTime: string | null
  crawlingUserAgent: string | null
  userCanonical: string | null
  googleCanonical: string | null
  sitemaps: string[] | null
  referringUrls: string[] | null
  mobileVerdict: string | null
  mobileIssues: unknown[] | null
  richResultsVerdict: string | null
  richResultsItems: unknown[] | null
  inspectionResultLink: string | null
  firstCheckedAt: string
  lastCheckedAt: string
  checkCount: number
}

export interface IndexingUrlsResponse {
  urls: IndexingUrlRow[]
  pagination: { total: number, limit: number, offset: number, hasMore: boolean }
  meta: { siteUrl: string, status: string, issue: string | null }
}

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
    data.value = await useGscFetch()<IndexingUrlsResponse>(
      `/api/__gsc/sites/${encodeURIComponent(id)}/indexing/urls`,
      { query },
    ).catch(() => null)
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
