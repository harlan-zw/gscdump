import type { GscdumpUserSite } from '@gscdump/contracts'
import type { PartnerFetch } from '@gscdump/sdk/partner'
import { createPartnerClient } from '@gscdump/sdk/partner'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const partner = config.partner as { apiBase?: string, apiKey?: string, userId?: string }

  if (!partner.apiKey || !partner.userId) {
    return {
      configured: false,
      sites: [] as GscdumpUserSite[],
      message: 'Set GSCDUMP_PARTNER_API_KEY and GSCDUMP_PARTNER_USER_ID to enable the Partner API prototype.',
    }
  }

  const client = createPartnerClient({
    apiBase: partner.apiBase || '/api',
    apiKey: partner.apiKey,
    fetch: $fetch as unknown as PartnerFetch,
  })
  const { sites } = await client.getUserSites(partner.userId)

  return {
    configured: true,
    apiBase: partner.apiBase || '/api',
    sites,
  }
})
