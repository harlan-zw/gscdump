import type { OAuth2Client } from 'google-auth-library'
import type { Credentials } from 'google-auth-library/build/src/auth/credentials.js'
import type { Auth as GscAuth } from 'gscdump/api'
import type { Result } from 'gscdump/result'
import type { Server } from 'node:http'
import type { GscdumpConfig } from './config'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { isCancel, text } from '@clack/prompts'
import { JWT as GoogleJWT, OAuth2Client as OAuth2ClientClass } from 'google-auth-library'
import { createAuth } from 'gscdump/api'
import { err, ok, unwrapResult } from 'gscdump/result'
import { ofetch } from 'ofetch'
import { getConfigDir, loadConfig } from './config'
import { getAppliedEnvKeys, getLoadedEnvPath } from './env-file'
import { displayPath, logger } from './utils'

/**
 * Modelled, caller-actionable auth failures. `kind`-discriminated (matching the
 * repo's `GscError`/`EngineError` convention, not `_tag`), paired with `Result`
 * so the `*Result` cores can be branched on / unit-tested without `try`/`catch`.
 * The throwing wrappers preserve the exact `.message` callers print today.
 *
 * Defects (a network IO blowup mid-poll the loop already retries, a programmer
 * invariant) are NOT modelled here; they keep propagating.
 */
export type AuthError
  = | { kind: 'not-service-account', path: string, accountType: string, message: string }
    | { kind: 'device-code-request-failed', message: string, cause?: unknown }
    | { kind: 'device-code-denied', message: string }
    | { kind: 'device-code-expired', message: string }
    | { kind: 'device-code-failed', reason: string, message: string }
    | { kind: 'device-code-timed-out', message: string }

function authErrorToException(error: AuthError): Error {
  const exception = new Error(error.message)
  if ('cause' in error && error.cause !== undefined)
    (exception as Error & { cause?: unknown }).cause = error.cause
  ;(exception as Error & { authError?: AuthError }).authError = error
  return exception
}

export interface BYOKOptions {
  accessToken?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
}

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
  'https://www.googleapis.com/auth/siteverification',
]

interface ServiceAccountKey {
  client_email: string
  private_key: string
  type: string
}

/**
 * Load a service-account JSON file (downloaded from Google Cloud) and return
 * a JWT-backed auth client compatible with `googleSearchConsole`. The service
 * account must have been granted access to the GSC properties separately
 * (Search Console > Settings > Users and permissions).
 */
/**
 * Errors-as-values core for {@link loadServiceAccount}: returns a typed
 * `not-service-account` `AuthError` when the JSON the user pointed at is the
 * wrong key type, so callers can distinguish "wrong file" from a read/parse
 * defect. The file-read / JSON-parse failures stay defects and propagate.
 */
export async function loadServiceAccountResult(jsonPath: string): Promise<Result<GoogleJWT, AuthError>> {
  const raw = await fs.readFile(jsonPath, 'utf-8')
  const key = JSON.parse(raw) as ServiceAccountKey
  if (key.type !== 'service_account')
    return err({ kind: 'not-service-account', path: jsonPath, accountType: key.type, message: `${jsonPath} is not a service-account key (type=${key.type})` })
  return ok(new GoogleJWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
  }))
}

export async function loadServiceAccount(jsonPath: string): Promise<GoogleJWT> {
  return unwrapResult(await loadServiceAccountResult(jsonPath), authErrorToException)
}

/**
 * Resolve a service-account auth client from `--service-account <path>`,
 * `GOOGLE_APPLICATION_CREDENTIALS`, `GSC_SERVICE_ACCOUNT_JSON`, or
 * `config.serviceAccountPath`. Returns null when no source is configured.
 */
export async function resolveServiceAccount(opts: { path?: string } = {}): Promise<GoogleJWT | null> {
  let p = opts.path
    || process.env.GSC_SERVICE_ACCOUNT_JSON
    || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!p) {
    const config = await loadConfig().catch(() => null)
    p = config?.serviceAccountPath
  }
  if (!p)
    return null
  return loadServiceAccount(p)
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_url: string
  expires_in: number
  interval: number
}
interface DeviceTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

/**
 * OAuth 2.0 device-code flow. Used when there's no browser / loopback
 * (headless servers, WSL2 without forwarding, containers). User opens the
 * URL on another device, types the code; we poll the token endpoint.
 */
export async function authenticateDeviceCode(credentials: OAuth2Credentials): Promise<Credentials> {
  return unwrapResult(await authenticateDeviceCodeResult(credentials), authErrorToException)
}

/**
 * Errors-as-values core for {@link authenticateDeviceCode}. Each terminal
 * outcome of the device-code flow (Google rejected the initial request, the
 * user denied, the code expired, the flow timed out, Google returned a hard
 * error) is a typed `AuthError` value the caller can branch on, rather than a
 * bare `throw` the global handler string-matches. `authorization_pending` /
 * `slow_down` keep looping; a transient network blip mid-poll is swallowed by
 * the inner `.catch` into a retry (a genuinely-expected, ignorable failure).
 */
export async function authenticateDeviceCodeResult(credentials: OAuth2Credentials): Promise<Result<Credentials, AuthError>> {
  // Step 1: ask Google for a device code.
  const init = await ofetch<DeviceCodeResponse>('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: credentials.clientId,
      scope: SCOPES.join(' '),
    }),
  }).then(ok<DeviceCodeResponse>).catch((e: Error) => err<AuthError>({ kind: 'device-code-request-failed', message: `Device-code request failed: ${e.message}`, cause: e }))
  if (!init.ok)
    return init
  return pollDeviceCode(credentials, init.value)
}

async function pollDeviceCode(credentials: OAuth2Credentials, init: DeviceCodeResponse): Promise<Result<Credentials, AuthError>> {
  console.log()
  console.log(`  \x1B[1mDevice-code OAuth\x1B[0m`)
  console.log(`  1. On any device, open: \x1B[36m${init.verification_url}\x1B[0m`)
  console.log(`  2. Enter this code:     \x1B[1m${init.user_code}\x1B[0m`)
  console.log(`  3. Approve the requested scopes`)
  console.log()
  logger.info(`Polling for completion (expires in ${Math.floor(init.expires_in / 60)}m)...`)

  // Step 2: poll until the user completes (or denies / expires).
  const intervalMs = init.interval * 1000
  const deadline = Date.now() + init.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs))
    const res = await ofetch<DeviceTokenResponse>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        device_code: init.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    }).catch((e: any) => e?.data ?? { error: 'request_failed' } as DeviceTokenResponse)

    if (res.access_token) {
      return ok({
        access_token: res.access_token,
        refresh_token: res.refresh_token,
        expiry_date: res.expires_in ? Date.now() + res.expires_in * 1000 : undefined,
      })
    }
    if (res.error === 'authorization_pending' || res.error === 'slow_down')
      continue
    if (res.error === 'access_denied')
      return err({ kind: 'device-code-denied', message: 'User denied authorization.' })
    if (res.error === 'expired_token')
      return err({ kind: 'device-code-expired', message: 'Device code expired. Re-run `gscdump auth login --no-browser`.' })
    if (res.error)
      return err({ kind: 'device-code-failed', reason: res.error, message: `Device-code poll failed: ${res.error_description || res.error}` })
  }
  return err({ kind: 'device-code-timed-out', message: 'Device-code flow timed out.' })
}

/**
 * Resolve BYOK from env + flags. Priority: explicit args > GSC_* env > GOOGLE_* env.
 * Returns a minimal `Auth` shape for `googleSearchConsole(auth)` if any BYOK is found,
 * otherwise null (caller falls back to OAuth2Client/saved tokens flow).
 */
export function resolveBYOK(opts: BYOKOptions = {}): GscAuth | null {
  const accessToken = opts.accessToken || process.env.GSC_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN
  const clientId = opts.clientId || process.env.GSC_CLIENT_ID || process.env.GOOGLE_CLIENT_ID
  const clientSecret = opts.clientSecret || process.env.GSC_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = opts.refreshToken || process.env.GSC_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN

  if (clientId && clientSecret && refreshToken)
    return createAuth({ clientId, clientSecret, refreshToken })
  if (accessToken)
    return accessToken
  return null
}

const REDIRECT_URI_RE = /redirect_uri=[^&]+/

function getTokensPath(): string {
  return path.join(getConfigDir(), 'tokens.json')
}

export interface OAuth2Credentials {
  clientId: string
  clientSecret: string
  redirectUri?: string
}

export async function loadTokens(): Promise<Credentials | null> {
  return fs.readFile(getTokensPath(), 'utf-8')
    .then(data => JSON.parse(data) as Credentials)
    .catch(() => null)
}

export async function saveTokens(tokens: Credentials): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 })
  await fs.writeFile(getTokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

export async function clearTokens(): Promise<void> {
  await fs.rm(getTokensPath()).catch(() => {})
  logger.success('Logged out, tokens cleared')
}

export async function getAuthCredentials(interactive: boolean): Promise<OAuth2Credentials> {
  const envClientId = process.env.GOOGLE_CLIENT_ID
  const envClientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (envClientId && envClientSecret) {
    if (interactive) {
      logger.info('Using OAuth client from env')
      console.log(`  \x1B[90m${envClientId}\x1B[0m`)
    }
    return { clientId: envClientId, clientSecret: envClientSecret }
  }

  const config = await loadConfig()
  if (config.clientId && config.clientSecret) {
    if (interactive) {
      logger.info(`Using OAuth client from ${displayPath(`${getConfigDir()}/config.json`)}`)
      console.log(`  \x1B[90m${config.clientId}\x1B[0m`)
    }
    return { clientId: config.clientId, clientSecret: config.clientSecret }
  }

  if (!interactive) {
    logger.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required for non-interactive mode')
    process.exit(1)
  }

  console.log()
  console.log('  \x1B[1mOAuth 2.0 Setup Required\x1B[0m')
  console.log('  \x1B[90mThe Google Search Console API requires OAuth 2.0 credentials.\x1B[0m')
  console.log()
  console.log('  \x1B[1mSteps:\x1B[0m')
  console.log('  \x1B[90m1.\x1B[0m Go to \x1B[36mhttps://console.developers.google.com/apis/credentials\x1B[0m')
  console.log('  \x1B[90m2.\x1B[0m Create credentials > OAuth client ID > Desktop application')
  console.log('  \x1B[90m3.\x1B[0m Enable "Search Console API" and "Web Search Indexing API" for your project')
  console.log('  \x1B[90m4.\x1B[0m Copy the Client ID and Client Secret')
  console.log()

  const clientIdResult = await text({
    message: 'Enter your Google OAuth Client ID:',
    placeholder: 'your-client-id.googleusercontent.com',
    validate: v => v ? undefined : 'Required',
  })
  if (isCancel(clientIdResult))
    process.exit(1)

  const clientSecretResult = await text({
    message: 'Enter your Google OAuth Client Secret:',
    validate: v => v ? undefined : 'Required',
  })
  if (isCancel(clientSecretResult))
    process.exit(1)

  console.log()
  logger.info('Tip: Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars to skip prompts')

  return { clientId: clientIdResult, clientSecret: clientSecretResult }
}

interface LoopbackAuthResult {
  code: string
  redirectUri: string
}

async function getAuthCodeViaLoopback(authUrl: string): Promise<LoopbackAuthResult> {
  return new Promise((resolve, reject) => {
    let resolvedRedirectUri = ''
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let server: Server

    const settle = (fn: () => void): void => {
      if (timeoutId)
        clearTimeout(timeoutId)
      server.closeAllConnections?.()
      server.close()
      fn()
    }

    server = createServer((req, res) => {
      const url = new URL(req.url || '', `http://127.0.0.1`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h1>Authorization Failed</h1><p>${error}</p><p>You can close this window.</p></body></html>`)
        settle(() => reject(new Error(`OAuth error: ${error}`)))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h1>Authorization Successful</h1><p>You can close this window and return to the terminal.</p></body></html>`)
        settle(() => resolve({ code, redirectUri: resolvedRedirectUri }))
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(`<html><body><h1>Missing authorization code</h1></body></html>`)
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        settle(() => reject(new Error('Failed to start local server')))
        return
      }

      const port = addr.port
      resolvedRedirectUri = `http://127.0.0.1:${port}`
      const fullAuthUrl = authUrl.replace(REDIRECT_URI_RE, `redirect_uri=${encodeURIComponent(resolvedRedirectUri)}`)

      console.log()
      console.log('  \x1B[1mOpening browser for authorization...\x1B[0m')
      console.log(`  \x1B[90mIf browser doesn't open, visit:\x1B[0m`)
      console.log(`  \x1B[36m${fullAuthUrl}\x1B[0m`)
      console.log()
      console.log(`  \x1B[90mIf Google says "redirect_uri_mismatch", your OAuth client is`)
      console.log(`  not a "Desktop application" type. Create a Desktop client at`)
      console.log(`  https://console.cloud.google.com/apis/credentials, then run`)
      console.log(`  \`gscdump init --force\` with the new ID/secret.\x1B[0m`)
      console.log()

      import('open').then(({ default: open }) => open(fullAuthUrl)).catch(() => {
        logger.warn('Could not open browser automatically')
      })
    })

    server.on('error', err => settle(() => reject(err)))

    timeoutId = setTimeout(() => {
      settle(() => reject(new Error('Authorization timed out. If Google showed "redirect_uri_mismatch", your OAuth client must be type "Desktop application" (create one at https://console.cloud.google.com/apis/credentials and run `gscdump init --force`).')))
    }, 5 * 60 * 1000)
  })
}

export async function authenticate(
  credentials: OAuth2Credentials,
  interactive: boolean,
  opts: { noBrowser?: boolean, force?: boolean } = {},
): Promise<OAuth2Client> {
  const oauth2Client = new OAuth2ClientClass(
    credentials.clientId,
    credentials.clientSecret,
    'http://127.0.0.1',
  )

  // `force` bypasses every shortcut (env tokens, saved tokens) so the user
  // can mint a fresh refresh_token after a scope change.
  const envAccessToken = !opts.force ? process.env.GOOGLE_ACCESS_TOKEN : undefined
  const envRefreshToken = !opts.force ? process.env.GOOGLE_REFRESH_TOKEN : undefined
  if (envAccessToken || envRefreshToken) {
    oauth2Client.setCredentials({
      access_token: envAccessToken,
      refresh_token: envRefreshToken,
    })
    if (envRefreshToken) {
      const { credentials: newTokens } = await oauth2Client.refreshAccessToken()
        .catch(() => ({ credentials: null }))
      if (newTokens)
        oauth2Client.setCredentials(newTokens)
    }
    return oauth2Client
  }

  const existingTokens = !opts.force ? await loadTokens() : null
  let refreshFailed = false
  let refreshError: Error | null = null
  if (existingTokens) {
    oauth2Client.setCredentials(existingTokens)

    if (existingTokens.expiry_date && existingTokens.expiry_date < Date.now()) {
      const result = await oauth2Client.refreshAccessToken()
        .then(r => ({ credentials: r.credentials, error: null as Error | null }))
        .catch((e: Error) => ({ credentials: null, error: e }))

      if (result.credentials) {
        await saveTokens(result.credentials)
        oauth2Client.setCredentials(result.credentials)
        if (interactive)
          logger.success('Token refreshed')
        return oauth2Client
      }
      refreshFailed = true
      refreshError = result.error
    }
    else {
      if (interactive)
        logger.success('Using saved credentials')
      return oauth2Client
    }
  }

  if (!interactive) {
    if (refreshFailed) {
      logger.error(`Token refresh failed${refreshError ? `: ${refreshError.message}` : ''}`)
      logger.info('Refresh token may be revoked or expired. Run `gscdump auth login` to re-authenticate.')
    }
    else {
      logger.error('Not authenticated')
      logger.info('Run `gscdump auth login` (or `gscdump init` for full setup).')
    }
    process.exit(1)
  }

  // Device-code flow: headless (no loopback / no browser). User opens the
  // verification URL on another device and types the user_code.
  if (opts.noBrowser) {
    const tokens = await authenticateDeviceCode(credentials)
    oauth2Client.setCredentials(tokens)
    await saveTokens(tokens)
    logger.success(`Tokens saved to ${displayPath(getTokensPath())}`)
    return oauth2Client
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })

  logger.info('Waiting for authorization...')
  const { code, redirectUri } = await getAuthCodeViaLoopback(authUrl)

  const tokenClient = new OAuth2ClientClass(
    credentials.clientId,
    credentials.clientSecret,
    redirectUri,
  )
  const { tokens } = await tokenClient.getToken(code)
  oauth2Client.setCredentials(tokens)
  await saveTokens(tokens)
  logger.success(`Tokens saved to ${displayPath(getTokensPath())}`)

  return oauth2Client
}

export interface GetAuthOptions {
  interactive?: boolean
  config?: GscdumpConfig
  /** Per-call BYOK override; if unset, env vars are checked. */
  byok?: BYOKOptions
  /** Use device-code flow instead of loopback. Headless / no-browser environments. */
  noBrowser?: boolean
  /** Force a fresh OAuth flow even if env tokens / saved tokens exist. */
  force?: boolean
  /** Path to a service-account JSON key. Falls back to GOOGLE_APPLICATION_CREDENTIALS / GSC_SERVICE_ACCOUNT_JSON. */
  serviceAccount?: string
}

export async function getAuth(opts: GetAuthOptions = {}): Promise<OAuth2Client> {
  const { interactive = true, noBrowser = false, force = false } = opts
  const credentials = await getAuthCredentials(interactive)
  return authenticate(credentials, interactive, { noBrowser, force })
}

/**
 * Returns the right auth shape for `googleSearchConsole(auth)`. Priority:
 *   1. Explicit / env-configured service-account JSON (JWT)
 *   2. BYOK env vars
 *   3. Saved OAuth tokens / interactive flow (loopback or device-code)
 */
export async function resolveAuth(opts: GetAuthOptions = {}): Promise<GscAuth | OAuth2Client | GoogleJWT> {
  const sa = await resolveServiceAccount({ path: opts.serviceAccount })
  if (sa) {
    logger.success('Using service-account credentials')
    return sa
  }
  const byok = resolveBYOK(opts.byok)
  if (byok) {
    if (typeof byok !== 'string')
      logger.success('Using BYOK credentials')
    return byok
  }
  return getAuth(opts)
}

interface ProvenanceRow {
  field: 'client_id' | 'client_secret' | 'refresh_token' | 'access_token' | 'service_account' | 'saved_tokens'
  source: string
  value: string | null
}

function envSourceLabel(envVar: string): string {
  return getAppliedEnvKeys().has(envVar) ? `.env (${envVar})` : `shell env (${envVar})`
}

function pickEnvSource(...envVars: string[]): { envVar: string, value: string } | null {
  for (const v of envVars) {
    const value = process.env[v]
    if (value)
      return { envVar: v, value }
  }
  return null
}

function redactCred(v: string | null | undefined, keepTail = 6): string {
  if (!v)
    return '<unset>'
  if (v.length <= keepTail)
    return '***'
  return `***${v.slice(-keepTail)}`
}

/**
 * Build a provenance breakdown: where each credential is coming from + which
 * one will actually be used (BYOK, saved tokens, service account). Used by
 * post-login warnings and by the global error handler to surface auth config
 * source when a 401 / invalid_grant comes back.
 */
export async function describeAuthProvenance(): Promise<{
  rows: ProvenanceRow[]
  effective: 'service-account' | 'byok-access-token' | 'byok-refresh-token' | 'saved-tokens' | 'none'
  warnings: string[]
}> {
  const rows: ProvenanceRow[] = []
  const warnings: string[] = []

  // service account
  const saEnvPath = process.env.GSC_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS
  const saConfigPath = !saEnvPath ? (await loadConfig().catch(() => null))?.serviceAccountPath : undefined
  const saPath = saEnvPath || saConfigPath
  if (saEnvPath) {
    const saEnv = process.env.GSC_SERVICE_ACCOUNT_JSON ? 'GSC_SERVICE_ACCOUNT_JSON' : 'GOOGLE_APPLICATION_CREDENTIALS'
    rows.push({ field: 'service_account', source: envSourceLabel(saEnv), value: displayPath(saEnvPath) })
  }
  else if (saConfigPath) {
    rows.push({ field: 'service_account', source: `${displayPath(`${getConfigDir()}/config.json`)}`, value: displayPath(saConfigPath) })
  }

  // OAuth client id / secret
  const clientId = pickEnvSource('GSC_CLIENT_ID', 'GOOGLE_CLIENT_ID')
  const clientSecret = pickEnvSource('GSC_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET')
  const config = await loadConfig().catch(() => null)
  if (clientId)
    rows.push({ field: 'client_id', source: envSourceLabel(clientId.envVar), value: clientId.value })
  else if (config?.clientId)
    rows.push({ field: 'client_id', source: `${displayPath(`${getConfigDir()}/config.json`)}`, value: config.clientId })
  else
    rows.push({ field: 'client_id', source: '<none>', value: null })

  if (clientSecret)
    rows.push({ field: 'client_secret', source: envSourceLabel(clientSecret.envVar), value: redactCred(clientSecret.value) })
  else if (config?.clientSecret)
    rows.push({ field: 'client_secret', source: `${displayPath(`${getConfigDir()}/config.json`)}`, value: redactCred(config.clientSecret) })
  else
    rows.push({ field: 'client_secret', source: '<none>', value: null })

  // BYOK tokens from env
  const accessTok = pickEnvSource('GSC_ACCESS_TOKEN', 'GOOGLE_ACCESS_TOKEN')
  const refreshTok = pickEnvSource('GSC_REFRESH_TOKEN', 'GOOGLE_REFRESH_TOKEN')
  if (accessTok)
    rows.push({ field: 'access_token', source: envSourceLabel(accessTok.envVar), value: redactCred(accessTok.value) })
  if (refreshTok)
    rows.push({ field: 'refresh_token', source: envSourceLabel(refreshTok.envVar), value: redactCred(refreshTok.value) })

  // Saved tokens on disk
  const tokens = await loadTokens()
  if (tokens) {
    const expiry = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'no expiry'
    rows.push({
      field: 'saved_tokens',
      source: displayPath(getTokensPath()),
      value: `access=${tokens.access_token ? 'present' : 'missing'}, refresh=${tokens.refresh_token ? 'present' : 'missing'}, expiry=${expiry}`,
    })
  }

  // Effective resolution priority mirrors resolveAuth().
  let effective: 'service-account' | 'byok-access-token' | 'byok-refresh-token' | 'saved-tokens' | 'none'
  if (saPath)
    effective = 'service-account'
  else if (clientId && clientSecret && refreshTok)
    effective = 'byok-refresh-token'
  else if (accessTok)
    effective = 'byok-access-token'
  else if (tokens)
    effective = 'saved-tokens'
  else
    effective = 'none'

  // Mismatch heuristics — surface footguns the user is likely hitting.
  const byokActive = effective === 'byok-refresh-token' || effective === 'byok-access-token'
  if (byokActive && tokens)
    warnings.push('BYOK env vars shadow saved tokens. If you just ran `auth login --force`, the env tokens are stale; unset them or update them.')

  if (effective === 'byok-refresh-token' && clientId && refreshTok) {
    const idFromEnvFile = getAppliedEnvKeys().has(clientId.envVar)
    const refreshFromEnvFile = getAppliedEnvKeys().has(refreshTok.envVar)
    if (idFromEnvFile !== refreshFromEnvFile)
      warnings.push(`client_id and refresh_token come from different sources (${envSourceLabel(clientId.envVar)} vs ${envSourceLabel(refreshTok.envVar)}); they may not match.`)
  }

  const envFile = getLoadedEnvPath()
  if (envFile && getAppliedEnvKeys().size > 0)
    warnings.push(`Loaded ${getAppliedEnvKeys().size} var(s) from ${displayPath(envFile)}.`)

  return { rows, effective, warnings }
}

/**
 * Render the provenance breakdown as a multi-line, indented string suitable
 * for printing under an error or warning.
 */
export async function formatAuthProvenance(): Promise<string> {
  const { rows, effective, warnings } = await describeAuthProvenance()
  const lines: string[] = []
  lines.push(`  \x1B[1mAuth config sources\x1B[0m \x1B[90m(effective: ${effective})\x1B[0m`)
  for (const r of rows) {
    const val = r.value ? ` \x1B[90m${r.value}\x1B[0m` : ''
    lines.push(`    ${r.field.padEnd(16)} \x1B[36m${r.source}\x1B[0m${val}`)
  }
  if (warnings.length > 0) {
    lines.push('')
    for (const w of warnings)
      lines.push(`  \x1B[33m!\x1B[0m ${w}`)
  }
  return lines.join('\n')
}

/**
 * Heuristic: does this error look like an auth/credentials problem? Used by
 * the global error handler to decide whether to append the provenance dump.
 */
export function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (!msg)
    return false
  return /\b(?:401|403|unauthorized|forbidden|invalid_grant|invalid_token|insufficient.*scope|invalid_client|token has been expired|token has been revoked)\b/.test(msg)
    || msg.includes('oauth2.googleapis.com/token')
}

export type { GscdumpConfig }
