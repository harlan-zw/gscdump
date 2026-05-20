// Reader for the layer's `AnalyticsClient`. Built once per NuxtApp by the
// layer plugin and provided as `$gscAnalyticsClient`. Hosts override by
// providing their own from a later plugin (e.g. to swap the SDK transport).

import type { AnalyticsClient } from '@gscdump/sdk'

export function useGscAnalyticsClient(): AnalyticsClient {
  return useNuxtApp().$gscAnalyticsClient as AnalyticsClient
}
