// Google OAuth2 token operations. Standalone helpers (no stateful client) so
// the result can be persisted by the caller. The bundled `googleSearchConsole`
// client builds tokens internally; this module is for callers that manage
// their own refresh-token storage and need a single-shot exchange.

import { GscApiError, parseGoogleError } from '../core/errors'

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Google's OAuth token endpoint typically responds in <1s. A 30s wait on a
// hung connection burns most of an edge worker's CPU budget on one failed
// call, so use a tighter per-attempt timeout and retry network/timeout
// failures with backoff. HTTP errors (invalid_grant, 4xx) are returned by
// Google quickly and surface here as `!res.ok` — never retried, as the
// refresh token is permanently bad.
const OAUTH_TIMEOUT_MS = 8_000
const OAUTH_MAX_ATTEMPTS = 3
const OAUTH_BACKOFF_MS = [0, 400, 1500]

export interface OAuthTokens {
  accessToken: string
  /** Unix seconds. */
  expiresAt: number
}

/**
 * Exchange a refresh token for an access token. Retries transient network
 * failures; surfaces HTTP failures (invalid_grant, etc.) immediately as
 * `GscApiError` so callers can mark the refresh token as bad.
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  return postOAuthToken(body, 'refresh')
}

/**
 * Exchange an authorization code (from the OAuth consent redirect) for
 * access + refresh tokens. Same retry / surface model as `refreshAccessToken`.
 */
export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<OAuthTokens & { refreshToken?: string }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  const tokens = await postOAuthToken(body, 'exchange')
  // refresh_token only present on first consent (or with prompt=consent)
  const refreshToken = (tokens as OAuthTokens & { refresh_token?: string }).refresh_token
  return { ...tokens, refreshToken }
}

async function postOAuthToken(body: URLSearchParams, op: 'refresh' | 'exchange'): Promise<OAuthTokens & Record<string, unknown>> {
  let lastError: unknown
  for (let attempt = 0; attempt < OAUTH_MAX_ATTEMPTS; attempt++) {
    if (OAUTH_BACKOFF_MS[attempt])
      await new Promise(r => setTimeout(r, OAUTH_BACKOFF_MS[attempt]))

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    }).catch((err: unknown) => {
      lastError = err
      return null
    })

    if (!res)
      continue

    if (!res.ok) {
      const text = await res.text()
      const info = parseGoogleError(text, res.status)
      throw new GscApiError(`Failed to ${op} token: ${info.message}`, info)
    }

    const data = await res.json() as { access_token: string, expires_in: number, refresh_token?: string }
    return {
      accessToken: data.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      refresh_token: data.refresh_token,
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`OAuth ${op} failed after ${OAUTH_MAX_ATTEMPTS} attempts`)
}
