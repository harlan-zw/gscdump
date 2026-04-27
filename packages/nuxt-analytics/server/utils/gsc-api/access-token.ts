// Host-controlled token seam. The layer never stores creds — it just calls the
// registered provider on demand.

import type { H3Event } from 'h3'
import type { AnalyticsIdentity, GscApiAccessTokenProvider } from '../../../types'

let _provider: GscApiAccessTokenProvider | null = null

export function registerGscApiAccessTokenProvider(provider: GscApiAccessTokenProvider): void {
  _provider = provider
}

export function getGscApiAccessTokenProvider(): GscApiAccessTokenProvider | null {
  return _provider
}

export async function resolveGscApiAccessToken(event: H3Event, identity: AnalyticsIdentity): Promise<string | null> {
  if (!_provider)
    return null
  return await _provider.getAccessToken(event, identity)
}
