// Google tokeninfo lookups for `doctor`, `auth status`, and the MCP
// diagnostics tool. The token goes in a POST body, never the URL, and every
// failure text is scrubbed of token material before anyone prints it.

import { ofetch } from 'ofetch'

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'
const TIMEOUT_MS = 5000

export interface TokenInfo {
  scope?: string
  email?: string
  expires_in?: number
  audience?: string
}

export type TokenInfoResult
  = | { kind: 'valid', info: TokenInfo }
    | { kind: 'invalid', detail: string }

type TokenInfoFetch = (url: string, init: { method: 'POST', body: URLSearchParams, timeout: number }) => Promise<TokenInfo>

// Google OAuth access tokens, refresh tokens, and `access_token=` pairs.
const TOKEN_PATTERNS = [/ya29\.[\w.-]+/g, /1\/\/[\w.-]{20,}/g, /(access_token|refresh_token)=[^&\s"']+/gi]

/** Remove token material from text that may reach a terminal or an agent. */
export function redactTokens(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret)
      out = out.split(secret).join('<redacted>')
  }
  for (const pattern of TOKEN_PATTERNS)
    out = out.replace(pattern, match => match.includes('=') ? `${match.slice(0, match.indexOf('='))}=<redacted>` : '<redacted>')
  return out
}

function describeFailure(error: unknown): string {
  const data = (error as { data?: { error_description?: unknown, error?: unknown } } | null)?.data
  const reason = typeof data?.error_description === 'string'
    ? data.error_description
    : typeof data?.error === 'string' ? data.error : undefined
  if (reason)
    return reason
  return error instanceof Error ? error.message : String(error)
}

/** Ask Google who owns `accessToken` and which scopes it carries. */
export async function fetchTokenInfo(
  accessToken: string,
  request: TokenInfoFetch = (url, init) => ofetch<TokenInfo>(url, init),
): Promise<TokenInfoResult> {
  return request(TOKENINFO_URL, {
    method: 'POST',
    body: new URLSearchParams({ access_token: accessToken }),
    timeout: TIMEOUT_MS,
  }).then(
    info => ({ kind: 'valid' as const, info }),
    (error: unknown) => ({ kind: 'invalid' as const, detail: redactTokens(describeFailure(error), [accessToken]) }),
  )
}

/** Token source with a refresh path: an OAuth client or a refresh-token BYOK object. */
interface RefreshingAuth {
  getAccessToken: () => Promise<{ token?: string | null }>
}

export type AccessTokenResult
  = | { kind: 'token', token: string }
    | { kind: 'failed', detail: string }

/**
 * Get a current access token. A refreshing source mints a new one first, so
 * a saved token that expired an hour ago never reaches tokeninfo.
 */
export async function currentAccessToken(auth: string | RefreshingAuth | object): Promise<AccessTokenResult> {
  if (typeof auth === 'string')
    return { kind: 'token', token: auth }
  if (!('getAccessToken' in auth) || typeof auth.getAccessToken !== 'function')
    return { kind: 'failed', detail: 'These credentials cannot produce an access token.' }
  return (auth as RefreshingAuth).getAccessToken().then(
    (result): AccessTokenResult => result.token
      ? { kind: 'token', token: result.token }
      : { kind: 'failed', detail: 'Google returned no access token.' },
    (error: unknown): AccessTokenResult => ({ kind: 'failed', detail: redactTokens(describeFailure(error)) }),
  )
}
