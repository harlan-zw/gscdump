// Recently added / removed URLs across a site's sitemaps over a rolling
// window. Backed by gscdump.com `/api/sites/[siteId]/sitemaps/changes`.

import { useGscFetch } from '../utils/gsc-fetch'

export interface SitemapAddedRow {
  url: string
  sitemap: string
  firstSeenAt: number
}

export interface SitemapRemovedRow {
  url: string
  sitemap: string
  removedAt: number
}

export interface SitemapChangesResponse {
  added: SitemapAddedRow[]
  removed: SitemapRemovedRow[]
  summary: { totalAdded: number, totalRemoved: number, period: { days: number } }
}

export interface UseGscSitemapChangesReturn {
  data: Readonly<Ref<SitemapChangesResponse | null>>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useGscSitemapChanges(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  days: MaybeRefOrGetter<number> = 7,
): UseGscSitemapChangesReturn {
  const data = ref<SitemapChangesResponse | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    if (!id) {
      data.value = null
      return
    }
    loading.value = true
    data.value = await useGscFetch()<SitemapChangesResponse>(
      `/api/__gsc/sites/${encodeURIComponent(id)}/sitemaps/changes`,
      { query: { days: toValue(days) } },
    ).catch(() => null)
    loading.value = false
  }

  watch([() => toValue(siteId), () => toValue(days)], refresh, { immediate: true })

  return {
    data: data as Readonly<typeof data>,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
  }
}
