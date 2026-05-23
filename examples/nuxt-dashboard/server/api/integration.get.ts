// Browser-fetched integration handshake.
//
// Returns apiKey/apiBase/userId for the client plugin to call `setGscAuth`
// and forward `x-api-key` on every `/api/__gsc/*` call. Mirrors nuxtseo.com's
// `/api/pro/gscdump-integration` shape.
//
// Prefers a user API key (`gsd_user_*`) when set — `/api/__gsc/sites` (the
// site fanout) only accepts user/team/CLI/session auth, not partner keys.
// Partner-only setups can register sites via /api/partner/* and pin a single
// siteId, but the multi-site dashboard needs a user-scoped key.

export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  const partner = config.partner as { apiBase?: string, apiKey?: string, userId?: string, userApiKey?: string }
  const analytics = (config.public as { analytics?: { apiBase?: string } }).analytics ?? {}

  const apiKey = partner.userApiKey || partner.apiKey || null
  const userId = partner.userId || null

  if (!apiKey) {
    return {
      configured: false,
      apiKey: null,
      apiBase: analytics.apiBase ?? '',
      userId: null,
      browserAnalyzerEnabled: false,
    }
  }

  return {
    configured: true,
    apiKey,
    apiBase: analytics.apiBase ?? '',
    userId,
    browserAnalyzerEnabled: true,
  }
})
