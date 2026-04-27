// DB provider seam. Hosts register an AnalyticsDbProvider at Nitro boot by
// calling `registerAnalyticsDbProvider(provider)` from a plugin. The layer's
// engine factory needs a drizzle-D1 handle for the manifest store; this seam
// keeps the layer free of drizzle imports (cf. internal/engine.ts where `db`
// is intentionally `unknown` at the boundary).
//
// Mirrors the auth/source/site provider pattern.

import type { H3Event } from 'h3'
import type { AnalyticsDbProvider } from '../../../types'
import { createError } from 'h3'

export type { AnalyticsDbProvider } from '../../../types'

let registered: AnalyticsDbProvider | null = null

export function registerAnalyticsDbProvider(provider: AnalyticsDbProvider): void {
  if (registered)
    console.warn('[gscdump:analytics] db provider already registered; replacing')
  registered = provider
}

export function getAnalyticsDbProvider(): AnalyticsDbProvider | null {
  return registered
}

export function requireDb(event: H3Event): unknown {
  const provider = registered
  if (!provider) {
    throw createError({
      statusCode: 500,
      statusMessage: 'analytics db provider not registered — host must call registerAnalyticsDbProvider() from a Nitro plugin',
    })
  }
  return provider.get(event)
}
