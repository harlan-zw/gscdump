// Auth seam. Hosts register an AnalyticsAuthProvider at Nitro boot by
// calling `registerAnalyticsAuthProvider(provider)` from a plugin. Request
// handlers resolve the viewer via `requireIdentity(event)`.
//
// We use a direct function call (not a Nuxt/Nitro hook) because plugin load
// order runs the layer's plugins before the host's — hook listeners from the
// host would register too late to receive a layer-side callHook fired at
// init. A module-scoped singleton + direct import sidesteps the ordering
// problem entirely; all plugins complete before any request handler runs.

import type { H3Event } from 'h3'
import type { AnalyticsAuthProvider, AnalyticsIdentity } from '../../../types'
import { createError } from 'h3'

let registered: AnalyticsAuthProvider | null = null

export function registerAnalyticsAuthProvider(provider: AnalyticsAuthProvider): void {
  if (registered)
    console.warn('[gscdump:analytics] auth provider already registered; replacing')
  registered = provider
}

export function getAnalyticsAuthProvider(): AnalyticsAuthProvider | null {
  return registered
}

export async function requireIdentity(event: H3Event): Promise<AnalyticsIdentity> {
  const provider = registered
  if (!provider) {
    throw createError({
      statusCode: 500,
      statusMessage: 'analytics auth provider not registered — host must call registerAnalyticsAuthProvider() from a Nitro plugin',
    })
  }

  const identity = await provider.resolve(event)
  if (!identity)
    throw createError({ statusCode: 401, statusMessage: 'unauthenticated' })

  return identity
}
