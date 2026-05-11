// Indexing-issue summary for a site: counts by issue type with severity.
// Backed by gscdump.com `/api/__gsc/sites/[siteId]/indexing/diagnostics`
// (alias re-exporting the `/api/sites/[siteId]/indexing/diagnostics` handler).

import type { IndexingDiagnostics } from '../../types'
import { useGscFetch } from '../utils/gsc-fetch'

export type { IndexingDiagnostics, IndexingIssue, IndexingIssueSeverity } from '../../types'

export interface UseGscIndexingDiagnosticsReturn {
  data: Readonly<Ref<IndexingDiagnostics | null>>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useGscIndexingDiagnostics(
  siteId: MaybeRefOrGetter<string | null | undefined>,
): UseGscIndexingDiagnosticsReturn {
  const data = ref<IndexingDiagnostics | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    if (!id) {
      data.value = null
      return
    }
    loading.value = true
    data.value = await useGscFetch()<IndexingDiagnostics>(
      `/api/__gsc/sites/${encodeURIComponent(id)}/indexing/diagnostics`,
    ).catch(() => null)
    loading.value = false
  }

  watch(() => toValue(siteId), refresh, { immediate: true })

  return {
    data: data as Readonly<typeof data>,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
  }
}
