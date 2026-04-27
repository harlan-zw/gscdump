// Site resolver seam. Hosts register an AnalyticsSiteResolver at Nitro boot
// by calling `registerAnalyticsSiteResolver(provider)` from a plugin. The
// layer's GSC-API endpoints resolve the site via
// `requireSite(event, identity, siteId)`.
//
// Mirrors the auth/source provider pattern (see auth.ts, source.ts) — direct
// module-scope registration, no callHook. The host owns the schema (which
// table holds sites, what `id` is, how to derive the canonical GSC URL); the
// layer just consumes the contract.

import type { H3Event } from 'h3'
import type { AnalyticsIdentity, AnalyticsSiteInfo, AnalyticsSiteResolver } from '../../../types'
import { createError } from 'h3'

export type { AnalyticsSiteInfo, AnalyticsSiteResolver } from '../../../types'

let registered: AnalyticsSiteResolver | null = null

export function registerAnalyticsSiteResolver(provider: AnalyticsSiteResolver): void {
  if (registered)
    console.warn('[gscdump:analytics] site resolver already registered; replacing')
  registered = provider
}

export function getAnalyticsSiteResolver(): AnalyticsSiteResolver | null {
  return registered
}

export async function requireSite(
  event: H3Event,
  identity: AnalyticsIdentity,
  siteId: string,
): Promise<AnalyticsSiteInfo> {
  const provider = registered
  if (!provider) {
    throw createError({
      statusCode: 500,
      statusMessage: 'analytics site resolver not registered — host must call registerAnalyticsSiteResolver() from a Nitro plugin',
    })
  }

  const site = await provider.resolve(event, identity, siteId)
  if (!site)
    throw createError({ statusCode: 404, statusMessage: 'Site not found' })

  return site
}
