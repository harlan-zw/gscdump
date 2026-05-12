// Typed reader for `runtimeConfig.public.analytics`. Single accessor so leaf
// composables stop re-typing the cast and silently drift when keys are added.

import type { GscAnalyticsRuntimeConfig } from '../../types'

export function useGscAnalyticsConfig(): GscAnalyticsRuntimeConfig {
  return useRuntimeConfig().public.analytics as unknown as GscAnalyticsRuntimeConfig
}
