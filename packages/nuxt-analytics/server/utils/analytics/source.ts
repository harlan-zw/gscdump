// Source seam. Hosts register an AnalyticsSourceProvider at Nitro boot by
// calling `registerAnalyticsSourceProvider(provider)` from a plugin. The
// analyze endpoint and source-info endpoint resolve the viewer's
// AnalysisQuerySource via `requireSource(event, identity, siteId)`.
//
// Mirrors the auth provider pattern (see auth.ts) — direct module-scope
// registration, no callHook, so plugin ordering doesn't matter.
//
// The layer does NOT interpret *which* source is returned. That's where
// business logic like free-vs-pro tier lives: hosts decide per-request.

import type { H3Event } from 'h3'
import type { AnalyticsIdentity, AnalyticsSourceProvider, AnalyticsSourceResolution } from '../../../types'
import { createError } from 'h3'

export type { AnalyticsSourceProvider, AnalyticsSourceResolution } from '../../../types'

let registered: AnalyticsSourceProvider | null = null

export function registerAnalyticsSourceProvider(provider: AnalyticsSourceProvider): void {
  if (registered)
    console.warn('[gscdump:analytics] source provider already registered; replacing')
  registered = provider
}

export function getAnalyticsSourceProvider(): AnalyticsSourceProvider | null {
  return registered
}

export async function requireSource(
  event: H3Event,
  identity: AnalyticsIdentity,
  siteId: string,
): Promise<AnalyticsSourceResolution> {
  const provider = registered
  if (!provider) {
    throw createError({
      statusCode: 500,
      statusMessage: 'analytics source provider not registered — host must call registerAnalyticsSourceProvider() from a Nitro plugin',
    })
  }

  const resolution = await provider.resolve(event, identity, siteId)
  if (!resolution)
    throw createError({ statusCode: 402, statusMessage: 'no analytics source available for this identity' })

  return resolution
}
