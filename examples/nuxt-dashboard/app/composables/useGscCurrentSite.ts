// Dashboard route convention `/sites/[id]/*` ↔ analytics layer's
// `useGscSite(siteId)`. Pages collapse to:
//   const { siteId, site } = useGscCurrentSite()
// The analytics layer is intentionally route-agnostic — this composable is
// the one place the `id` param name is hard-coded.

import type { ComputedRef } from 'vue'

export function useGscCurrentSite(): {
  siteId: ComputedRef<string>
  site: ReturnType<typeof useGscSite>
} {
  const route = useRoute()
  const siteId = computed(() => String(route.params.id))
  return { siteId, site: useGscSite(siteId) }
}
