// Site context provide/inject. Lets a parent route hold the resolved
// SiteRecord once and have descendant pages/components read it without
// prop-drilling. Independent of any query composable; pair with
// `useGscQuery` by passing `site: () => useSiteRecord().value?.id`.
//
// SiteRecord / ReadBackend live in useGscAnalytics — both files re-exporting
// them tripped Nuxt's auto-import scanner ("Duplicated imports").

import type { InjectionKey, Ref } from 'vue'
import type { SiteRecord } from './useGscAnalytics'

const SITE_RECORD_KEY = Symbol('gscSiteRecord') as InjectionKey<Ref<SiteRecord | null>>

export function provideSiteRecord(record: Ref<SiteRecord | null>): void {
  provide(SITE_RECORD_KEY, record)
}

export function useSiteRecord(): Ref<SiteRecord | null> {
  return inject(SITE_RECORD_KEY, null) ?? ref(null)
}
