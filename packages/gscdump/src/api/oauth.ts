// Google OAuth2 token operations. Standalone helpers (no stateful client) so
// the result can be persisted by the caller. The bundled `googleSearchConsole`
// client builds tokens internally; this module is for callers that manage
// their own refresh-token storage and need a single-shot exchange.

import type { GscApiErrorInfo, GscError } from '../core/errors'
import type { Result } from '../core/result'
import { GscApiError, gscErrorToException, parseGoogleError } from '../core/errors'
import { err, ok, unwrapResult } from '../core/result'

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const OAUTH_TOKEN_INFO_URL = 'https://oauth2.googleapis.com/tokeninfo'
const OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

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
  /** Space-delimited scopes Google granted for this token, when returned. */
  scope?: string
}

/** Normalized response from Google's access-token introspection endpoint. */
export interface OAuthTokenInfo {
  issuedTo?: string
  audience?: string
  authorizedParty?: string
  userId?: string
  subject?: string
  scope?: string
  /** Seconds remaining when Google inspected the token. */
  expiresIn?: number
  /** Unix seconds. */
  expiresAt?: number
  email?: string
  emailVerified?: boolean
  accessType?: string
}

interface OAuthTokenEndpointTokens extends OAuthTokens {
  refreshToken?: string
}

/**
 * Errors-as-values core for {@link refreshAccessToken}: returns a classified
 * `GscError` instead of throwing, so token-storage callers can branch on
 * `error.kind` — `auth-expired` (the refresh token is permanently bad, re-auth)
 * vs `transport` (transient, safe to retry later) — rather than string-matching.
 */
async function refreshAccessTokenResult(
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
  const result = await postOAuthTokenResult(body, 'refresh')
  if (!result.ok)
    return result
  return ok({
    accessToken: result.value.accessToken,
    expiresAt: result.value.expiresAt,
    scope: result.value.scope,
  })
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
 * Exchange an authorization code (from the OAuth consent redirect) for
 * access + refresh tokens. Same retry / surface model and `auth-expired` vs
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
  return result
}

/** Inspect an access token without throwing on expected OAuth failures. */
export async function introspectAccessTokenResult(
  accessToken: string,
): Promise<Result<OAuthTokenInfo, GscError>> {
  const response = await requestOAuthResult(
    `${OAUTH_TOKEN_INFO_URL}?access_token=${encodeURIComponent(accessToken)}`,
    { method: 'GET' },
    'introspect',
  )
  if (!response.ok)
    return response

  const parsed = await readOAuthJsonResult<Record<string, unknown>>(response.value, 'introspect')
  if (!parsed.ok)
    return parsed

  const data = parsed.value
  return ok({
    issuedTo: optionalString(data.issued_to),
    audience: optionalString(data.aud),
    authorizedParty: optionalString(data.azp),
    userId: optionalString(data.user_id),
    subject: optionalString(data.sub),
    scope: optionalString(data.scope),
    expiresIn: optionalNumber(data.expires_in),
    expiresAt: optionalNumber(data.exp),
    email: optionalString(data.email),
    emailVerified: optionalBoolean(data.email_verified),
    accessType: optionalString(data.access_type),
  })
}

/** Throwing convenience wrapper for {@link introspectAccessTokenResult}. */
export async function introspectAccessToken(accessToken: string): Promise<OAuthTokenInfo> {
  return unwrapResult(await introspectAccessTokenResult(accessToken), oauthErrorToException)
}

/** Revoke an access or refresh token without throwing on expected OAuth failures. */
export async function revokeOAuthTokenResult(token: string): Promise<Result<void, GscError>> {
  const response = await requestOAuthResult(
    OAUTH_REVOKE_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    },
    'revoke',
  )
  return response.ok ? ok(undefined) : response
}

/** Throwing convenience wrapper for {@link revokeOAuthTokenResult}. */
export async function revokeOAuthToken(token: string): Promise<void> {
  return unwrapResult(await revokeOAuthTokenResult(token), oauthErrorToException)
}

/**
 * Classify a Google token-endpoint HTTP failure. Any non-2xx from the token
 * endpoint means the grant is unusable (the original code never retried them);
 * `invalid_grant` and 4xx are caller-actionable `auth-expired`, the rest stay
 * `transport`. The original `GscApiError` is preserved as `cause` so the throwing
 * wrappers re-raise it unchanged.
 */
type OAuthOperation = 'refresh' | 'exchange' | 'introspect' | 'revoke'

function oauthHttpError(op: OAuthOperation, info: GscApiErrorInfo): GscError {
  const message = `Failed to ${op} token: ${info.message}`
  const cause = new GscApiError(message, info)
  const isAuthFailure = info.reason === 'invalid_grant' || info.reason === 'invalid_token'
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
): Promise<Result<OAuthTokenEndpointTokens, GscError>> {
  const response = await requestOAuthResult(
    OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    op,
  )
  if (!response.ok)
    return response

  const parsed = await readOAuthJsonResult<{
    access_token: string
    expires_in: number
    refresh_token?: string
    scope?: string
  }>(response.value, op)
  if (!parsed.ok)
    return parsed

  const data = parsed.value
  if (typeof data.access_token !== 'string' || !data.access_token.trim()
    || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in < 0
    || (data.refresh_token !== undefined && typeof data.refresh_token !== 'string')
    || (data.scope !== undefined && typeof data.scope !== 'string')) {
    return err({
      kind: 'transport',
      message: `Invalid ${op} token response`,
      status: response.value.status,
      cause: new TypeError('OAuth response requires a nonempty access_token and a finite, nonnegative expires_in.'),
    })
  }
  return ok({
    accessToken: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    refreshToken: data.refresh_token,
    scope: data.scope,
  })
}

async function requestOAuthResult(
  url: string,
  init: RequestInit,
  op: OAuthOperation,
): Promise<Result<Response, GscError>> {
  let lastError: unknown
  for (let attempt = 0; attempt < OAUTH_MAX_ATTEMPTS; attempt++) {
    if (OAUTH_BACKOFF_MS[attempt])
      await new Promise(r => setTimeout(r, OAUTH_BACKOFF_MS[attempt]))

    const res = await fetch(url, {
      ...init,
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

    return ok(res)
  }

  // All attempts exhausted on transient network/timeout failures.
  return err({
    kind: 'transport',
    message: lastError instanceof Error ? lastError.message : `OAuth ${op} failed after ${OAUTH_MAX_ATTEMPTS} attempts`,
    cause: lastError,
  })
}

async function readOAuthJsonResult<T>(
  response: Response,
  op: OAuthOperation,
): Promise<Result<T, GscError>> {
  try {
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('OAuth response must be an object.')
    return ok(value as T)
  }
  catch (cause) {
    return err({
      kind: 'transport',
      message: `Failed to parse ${op} token response`,
      status: response.status,
      cause,
    })
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean')
    return value
  if (value === 'true')
    return true
  if (value === 'false')
    return false
  return undefined
}
