import type { BingWebmasterClient } from 'gscdump/bing'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { bingWebmaster } from 'gscdump/bing'
import { z } from 'zod'
import { getConfigDir } from './config'
import { useCliRuntime } from './runtime'

const secret = z.string().trim().min(1)
const oauthClientSchema = z.object({
  clientId: secret,
  clientSecret: secret,
  redirectUri: z.url(),
})
const credentialsSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('ApiKey'), apiKey: secret }),
  z.object({
    _tag: z.literal('OAuth'),
    ...oauthClientSchema.shape,
    accessToken: secret,
    refreshToken: secret,
    expiresAt: z.number().finite().positive(),
  }),
])
const tokenSchema = z.object({
  access_token: secret,
  refresh_token: secret.optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive().max(31_536_000)),
})

type BingCredentials = z.infer<typeof credentialsSchema>
type OAuthClient = z.infer<typeof oauthClientSchema>

export const BING_REDIRECT_URI = 'http://127.0.0.1:53683/oauth/bing'

function credentialsPath(): string {
  return path.join(getConfigDir(), 'bing-tokens.json')
}

export async function saveBingCredentials(credentials: BingCredentials): Promise<void> {
  const value = credentialsSchema.parse(credentials)
  await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 })
  const temporary = `${credentialsPath()}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, credentialsPath())
  }
  finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function clearBingCredentials(): Promise<void> {
  await fs.rm(credentialsPath(), { force: true })
}

export async function inspectBingCredentials(): Promise<{ _tag: 'Missing' | 'ApiKey' | 'OAuth' | 'AccessToken' }> {
  const env = useCliRuntime().environment
  if (env.BING_API_KEY?.trim())
    return { _tag: 'ApiKey' }
  if (env.BING_ACCESS_TOKEN?.trim())
    return { _tag: 'AccessToken' }
  const credentials = await loadBingCredentials()
  return { _tag: credentials?._tag ?? 'Missing' }
}

async function loadBingCredentials(): Promise<BingCredentials | null> {
  const body = await fs.readFile(credentialsPath(), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (body === null)
    return null
  const parsed = credentialsSchema.safeParse(JSON.parse(body))
  if (!parsed.success)
    throw new Error('Saved Bing credentials are invalid. Run `gscdump bing login` again.')
  return parsed.data
}

async function requestToken(client: OAuthClient, grant: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
  const response = await fetch('https://www.bing.com/webmasters/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: client.redirectUri, ...grant }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new Error(`Bing token request failed (${response.status}). Run \`gscdump bing login --oauth\` again.`)
  const payload = await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError)
      throw new Error('Bing returned an invalid OAuth token.')
    throw error
  })
  const token = tokenSchema.safeParse(payload)
  if (!token.success)
    throw new Error('Bing returned an invalid OAuth token.')
  return token.data
}

export async function getBingClient(): Promise<BingWebmasterClient> {
  const env = useCliRuntime().environment
  if (env.BING_API_KEY?.trim())
    return bingWebmaster({ apiKey: env.BING_API_KEY.trim() })
  if (env.BING_ACCESS_TOKEN?.trim())
    return bingWebmaster({ accessToken: env.BING_ACCESS_TOKEN.trim() })
  const credentials = await loadBingCredentials()
  if (!credentials)
    throw new Error('Bing credentials are missing. Run `gscdump bing login` or set BING_API_KEY.')
  if (credentials._tag === 'ApiKey')
    return bingWebmaster({ apiKey: credentials.apiKey })
  let current = credentials
  let refreshing: Promise<string> | undefined
  const accessToken = (): Promise<string> => {
    if (current.expiresAt > Date.now() + 60_000)
      return Promise.resolve(current.accessToken)
    // Parallel dataset requests share one refresh, including refresh-token rotation.
    refreshing ??= requestToken(current, { grant_type: 'refresh_token', refresh_token: current.refreshToken })
      .then(async (token) => {
        const updated = {
          ...current,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? current.refreshToken,
          expiresAt: Date.now() + token.expires_in * 1000,
        }
        await saveBingCredentials(updated)
        current = updated
        return updated.accessToken
      })
      .finally(() => { refreshing = undefined })
    return refreshing
  }
  // Report an expired/revoked grant at client creation as well as during long exports.
  await accessToken()
  return bingWebmaster({ accessToken })
}

/** Receive one consent result on loopback. An unrelated request cannot consume the login. */
export async function loginBingOAuth(input: OAuthClient & {
  openUrl: (url: string) => Promise<void>
  timeoutMs?: number
}): Promise<void> {
  const parsed = oauthClientSchema.safeParse(input)
  if (!parsed.success)
    throw new Error('Bing OAuth needs a client ID, client secret, and redirect URI.')
  const client = parsed.data
  const redirect = new URL(client.redirectUri)
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(redirect.hostname)
    || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('Use an HTTP loopback redirect URI with an explicit port and no query or fragment.')
  }
  const state = randomUUID()
  const authorize = new URL('https://www.bing.com/webmasters/oauth/authorize')
  authorize.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: 'webmaster.manage',
    state,
  }).toString()

  const result = Promise.withResolvers<string>()
  // Install the rejection handler before opening a browser or waiting for listen.
  const settled = result.promise.then(code => ({ code }), (error: unknown) => ({ error }))
  const server = createServer((request, response) => {
    const callback = URL.parse(request.url ?? '/', redirect.origin)
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    if (!callback) {
      response.writeHead(400).end('Invalid OAuth callback URL.')
      return
    }
    if (request.method !== 'GET' || callback.pathname !== redirect.pathname) {
      response.writeHead(404).end('Not found.')
      return
    }
    if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state
      || callback.searchParams.getAll('code').length > 1 || callback.searchParams.getAll('error').length > 1) {
      response.writeHead(400).end('Invalid OAuth state. Use the original login link.')
      return
    }
    const code = callback.searchParams.get('code')
    if ((!code && !callback.searchParams.has('error')) || (code && callback.searchParams.has('error'))) {
      response.writeHead(400).end('Invalid OAuth response. Use the original login link.')
      return
    }
    if (callback.searchParams.has('error') || !code) {
      response.writeHead(400).end('Bing authorization failed. Return to the terminal.')
      result.reject(new Error('Bing authorization failed. Run `gscdump bing login --oauth` again.'))
      return
    }
    response.end('Bing authorization received. Return to the terminal.')
    result.resolve(code)
  })
  const timeout = setTimeout(() => result.reject(new Error('Bing login timed out. Run `gscdump bing login --oauth` again.')), input.timeoutMs ?? 300_000)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(Number(redirect.port), redirect.hostname, () => resolve())
    })
    await input.openUrl(authorize.toString())
    const authorization = await settled
    if ('error' in authorization)
      throw authorization.error
    const token = await requestToken(client, { grant_type: 'authorization_code', code: authorization.code })
    if (!token.refresh_token)
      throw new Error('Bing did not return a refresh token. Run `gscdump bing login --oauth` again.')
    const sites = await bingWebmaster({ accessToken: token.access_token }).getUserSites({ signal: AbortSignal.timeout(30_000) })
    if (!sites.ok)
      throw new Error(`Bing login failed: ${sites.error._tag}.`)
    await saveBingCredentials({
      _tag: 'OAuth',
      ...client,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    })
  }
  finally {
    clearTimeout(timeout)
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}
