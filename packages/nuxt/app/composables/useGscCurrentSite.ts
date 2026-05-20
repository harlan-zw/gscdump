// Dashboard route convention `/sites/[id]/*` ↔ analytics layer's
// `useGscSite(siteId)`. Pages collapse to:
//   const { siteId, site } = useGscCurrentSite()
// The analytics layer is otherwise route-agnostic — this composable is the
// one place the `id` param name is hard-coded. Hosts using a different param
// name should provide their own equivalent.

export function useGscCurrentSite(): {
  siteId: ComputedRef<string>
  site: ReturnType<typeof useGscSite>
} {
  const route = useRoute()
  const siteId = computed(() => String(route.params.id))
  return { siteId, site: useGscSite(siteId) }
}
