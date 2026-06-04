// Google OAuth2 token operations. Standalone helpers (no stateful client) so
// the result can be persisted by the caller. The bundled `googleSearchConsole`
// client builds tokens internally; this module is for callers that manage
// their own refresh-token storage and need a single-shot exchange.

import type { GscApiErrorInfo, GscError } from '../core/errors'
import type { Result } from '../core/result'
import { GscApiError, gscErrorToException, parseGoogleError } from '../core/errors'
import { err, ok, unwrapResult } from '../core/result'

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
 * Errors-as-values core for {@link refreshAccessToken}: returns a classified
 * `GscError` instead of throwing, so token-storage callers can branch on
 * `error.kind` — `auth-expired` (the refresh token is permanently bad, re-auth)
 * vs `transport` (transient, safe to retry later) — rather than string-matching.
 */
export async function refreshAccessTokenResult(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<Result<OAuthTokens, GscError>> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  return postOAuthTokenResult(body, 'refresh')
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
  return unwrapResult(
    await refreshAccessTokenResult(refreshToken, clientId, clientSecret),
    oauthErrorToException,
  )
}

/**
 * Errors-as-values core for {@link exchangeAuthCode}: same `auth-expired` vs
 * `transport` classification as {@link refreshAccessTokenResult}.
 */
export async function exchangeAuthCodeResult(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<Result<OAuthTokens & { refreshToken?: string }, GscError>> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  const result = await postOAuthTokenResult(body, 'exchange')
  if (!result.ok)
    return result
  // refresh_token only present on first consent (or with prompt=consent)
  const refreshToken = (result.value as OAuthTokens & { refresh_token?: string }).refresh_token
  return ok({ ...result.value, refreshToken })
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
  return unwrapResult(
    await exchangeAuthCodeResult(code, clientId, clientSecret, redirectUri),
    oauthErrorToException,
  )
}

/**
 * Classify a Google token-endpoint HTTP failure. Any non-2xx from the token
 * endpoint means the grant is unusable (the original code never retried them);
 * `invalid_grant` and 4xx are caller-actionable `auth-expired`, the rest stay
 * `transport`. The original `GscApiError` is preserved as `cause` so the throwing
 * wrappers re-raise it unchanged.
 */
function oauthHttpError(op: 'refresh' | 'exchange', info: GscApiErrorInfo): GscError {
  const message = `Failed to ${op} token: ${info.message}`
  const cause = new GscApiError(message, info)
  const isAuthFailure = info.reason === 'invalid_grant'
    || info.code === 400 || info.code === 401 || info.code === 403
  return isAuthFailure
    ? { kind: 'auth-expired', message, cause }
    : { kind: 'transport', message, status: info.code, cause }
}

/**
 * Re-raise an oauth `GscError`, preserving the original `GscApiError`/network
 * error identity callers already catch.
 */
function oauthErrorToException(error: GscError): unknown {
  return error.cause instanceof Error ? error.cause : gscErrorToException(error)
}

async function postOAuthTokenResult(
  body: URLSearchParams,
  op: 'refresh' | 'exchange',
): Promise<Result<OAuthTokens & Record<string, unknown>, GscError>> {
  let lastError: unknown
  for (let attempt = 0; attempt < OAUTH_MAX_ATTEMPTS; attempt++) {
    if (OAUTH_BACKOFF_MS[attempt])
      await new Promise(r => setTimeout(r, OAUTH_BACKOFF_MS[attempt]))

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    }).catch((error: unknown) => {
      lastError = error
      return null
    })

    if (!res)
      continue

    if (!res.ok) {
      const text = await res.text()
      const info = parseGoogleError(text, res.status)
      return err(oauthHttpError(op, info))
    }

    const data = await res.json() as { access_token: string, expires_in: number, refresh_token?: string }
    return ok({
      accessToken: data.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      refresh_token: data.refresh_token,
    })
  }

  // All attempts exhausted on transient network/timeout failures.
  return err({
    kind: 'transport',
    message: lastError instanceof Error ? lastError.message : `OAuth ${op} failed after ${OAUTH_MAX_ATTEMPTS} attempts`,
    cause: lastError,
  })
}
