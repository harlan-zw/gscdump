// Site context provide/inject. Lets a parent route hold the resolved
// SiteRecord once and have descendant pages/components read it without
// prop-drilling. Independent of any query composable; pair with
// `useGscQuery` by passing `site: () => useSiteRecord().value?.id`.
//
// Reuses the canonical SiteRecord/ReadBackend types from useGscAnalytics so
// auto-imports don't collide.

import type { InjectionKey, Ref } from 'vue'
import type { ReadBackend, SiteRecord } from './useGscAnalytics'

export type { ReadBackend, SiteRecord }

const SITE_RECORD_KEY = Symbol('gscSiteRecord') as InjectionKey<Ref<SiteRecord | null>>

export function provideSiteRecord(record: Ref<SiteRecord | null>): void {
  provide(SITE_RECORD_KEY, record)
}

export function useSiteRecord(): Ref<SiteRecord | null> {
  return inject(SITE_RECORD_KEY, null) ?? ref(null)
}
