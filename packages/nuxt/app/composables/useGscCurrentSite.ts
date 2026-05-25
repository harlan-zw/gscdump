import type { ComputedRef, InjectionKey } from 'vue'

export interface GscCurrentSiteContext {
  siteId: ComputedRef<string>
  site: ReturnType<typeof useGscSite>
}

export const gscCurrentSiteKey: InjectionKey<GscCurrentSiteContext> = Symbol('gsc-current-site')

function createGscCurrentSiteContext(siteId: MaybeRefOrGetter<string | null | undefined>): GscCurrentSiteContext {
  const resolvedSiteId = computed(() => String(toValue(siteId) ?? ''))
  return { siteId: resolvedSiteId, site: useGscSite(resolvedSiteId) }
}

/**
 * Provide the current-site context for a dashboard subtree. Hosts with a route
 * shape other than `/sites/[id]/*` should call this from their layout/page.
 */
export function provideGscCurrentSite(siteId: MaybeRefOrGetter<string | null | undefined>): GscCurrentSiteContext {
  const ctx = createGscCurrentSiteContext(siteId)
  provide(gscCurrentSiteKey, ctx)
  return ctx
}

/**
 * Read the current-site context. Falls back to the historical `/sites/[id]/*`
 * route convention for existing hosts that have not added a provider yet.
 */
export function useGscCurrentSite(): GscCurrentSiteContext {
  const provided = inject(gscCurrentSiteKey, null)
  if (provided)
    return provided

  const route = useRoute()
  return createGscCurrentSiteContext(() => route.params.id as string | undefined)
}
