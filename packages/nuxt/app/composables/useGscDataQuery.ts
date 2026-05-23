import type { UseNuxtQueryOptions } from '#nuxt-query/composables/useNuxtQuery'
import { useNuxtQuery } from '#nuxt-query/composables/useNuxtQuery'
import { invalidateNuxtQueries } from '#nuxt-query/composables/useQueryCache'
import { useGscFetch } from '../utils/gsc-fetch'

// `useGscDataQuery` is the gscdump-flavoured `useNuxtQuery`: same shape, with
// `$gscFetch` wired in as the default fetcher so callsites drop the
// `{ $fetch: useGscFetch() }` boilerplate. Auth + apiBase resolution lives in
// `$gscFetch`; SWR / dedup / gating live in `modules/nuxt-query`.
//
// Pass an explicit type for typed reads:
//   `useGscDataQuery<SiteListItem[]>('/api/__gsc/sites', { key: 'gsc:sites' })`

export type UseGscDataQueryOptions<T> = UseNuxtQueryOptions<T>

export function useGscDataQuery<T>(
  url: string | (() => string),
  opts: UseGscDataQueryOptions<T>,
) {
  return useNuxtQuery<T>(url, {
    $fetch: useGscFetch() as UseNuxtQueryOptions<T>['$fetch'],
    ...opts,
  } as UseNuxtQueryOptions<T>)
}

/** Prefix-invalidate cached gscdump queries (e.g. `invalidateGscQueries('gsc:rollup:')`). */
export const invalidateGscQueries = invalidateNuxtQueries
