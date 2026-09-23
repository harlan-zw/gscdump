import type { OAuth2Client } from 'google-auth-library'
import type { Credentials } from 'google-auth-library/build/src/auth/credentials.js'
import type { Auth as GscAuth } from 'gscdump/client'
import type { Result } from 'gscdump/result'
import type { GscdumpConfig } from './config'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as waitForPoll } from 'node:timers/promises'
import { text } from '@clack/prompts'
import { CodeChallengeMethod, JWT as GoogleJWT, OAuth2Client as OAuth2ClientClass } from 'google-auth-library'
import { createAuth } from 'gscdump/client'
import { err, ok, unwrapResult } from 'gscdump/result'
import open from 'open'
import { resolveAuthentication } from './auth-state'
import { getConfigDir, loadConfig } from './config'
import { getAppliedEnvKeys, getLoadedEnvPath } from './env-file'
import { pickCliEnvironmentValue, resolveCliEnvironment } from './environment'
import { loginWithPlatform, refreshWithPlatform } from './hosted-auth'
import { displayPath, logger } from './utils'

/** Caller-actionable failures use the repository's `kind` and `Result` convention. */
export type AuthError
  = | { kind: 'not-service-account', path: string, accountType: string, message: string }
    | { kind: 'oauth-denied', message: string }
    | { kind: 'oauth-failed', message: string }
    | { kind: 'oauth-timed-out', message: string }

function authErrorToException(error: AuthError): Error {
  const exception = new Error(error.message)
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
  let p = opts.path || resolveCliEnvironment().serviceAccountPath
  if (!p) {
    const config = await loadConfig().catch(() => null)
    p = config?.serviceAccountPath
  }
  if (!p)
    return null
  return loadServiceAccount(p)
}

/**
 * Resolve BYOK from env + flags. Priority: explicit args > GSC_* env > GOOGLE_* env.
 * Returns a minimal `Auth` shape for `googleSearchConsole(auth)` if any BYOK is found,
 * otherwise null (caller falls back to OAuth2Client/saved tokens flow).
 */
export function resolveBYOK(opts: BYOKOptions = {}): GscAuth | null {
  const env = resolveCliEnvironment()
  const accessToken = opts.accessToken || env.accessToken
  const clientId = opts.clientId || env.clientId
  const clientSecret = opts.clientSecret || env.clientSecret
  const refreshToken = opts.refreshToken || env.refreshToken

  if (clientId && clientSecret && refreshToken)
    return createAuth({ clientId, clientSecret, refreshToken })
  if (accessToken)
    return accessToken
  return null
}

function getTokensPath(): string {
  return path.join(getConfigDir(), 'tokens.json')
}

/** Every way to connect Google, for commands that found no credentials. */
export const GOOGLE_NOT_CONNECTED = [
  'Google is not connected. Use one of these:',
  '  Local:  gscdump auth login',
  '  Hosted: gscdump auth login --mode cloud --api-key KEY (a gscdump.com API key)',
  '  BYOK:   set GSC_ACCESS_TOKEN, or GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN',
].join('\n')

export interface OAuth2Credentials {
  clientId: string
  clientSecret: string
  redirectUri?: string
}

export type SavedTokens = Credentials & { provider?: 'gscdump' }

export async function loadTokens(): Promise<SavedTokens | null> {
  return fs.readFile(getTokensPath(), 'utf-8')
    .then(data => JSON.parse(data) as SavedTokens)
    .catch(() => null)
}

export async function saveTokens(tokens: SavedTokens): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 })
  await fs.writeFile(getTokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

export async function clearTokens(): Promise<void> {
  await fs.rm(getTokensPath(), { force: true })
  logger.success('Logged out, tokens cleared')
}

export async function getAuthCredentials(interactive: boolean): Promise<OAuth2Credentials> {
  const env = resolveCliEnvironment()
  const envClientId = env.clientId
  const envClientSecret = env.clientSecret

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
  if (typeof clientIdResult !== 'string')
    process.exit(1)

  const clientSecretResult = await text({
    message: 'Enter your Google OAuth Client Secret:',
    validate: v => v ? undefined : 'Required',
  })
  if (typeof clientSecretResult !== 'string')
    process.exit(1)

  console.log()
  logger.info('Tip: Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars to skip prompts')

  return { clientId: clientIdResult, clientSecret: clientSecretResult }
}

interface LoopbackAuthResult {
  code: string
  redirectUri: string
}

async function getAuthCodeViaLoopback(authUrl: URL, expectedState: string, noBrowser: boolean): Promise<LoopbackAuthResult> {
  return new Promise((resolve, reject) => {
    let resolvedRedirectUri = ''
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const server = createServer()

    const settle = (result: Result<LoopbackAuthResult, Error>): void => {
      if (settled)
        return
      settled = true
      clearTimeout(timeoutId)
      server.close()
      server.closeAllConnections()
      if (result.ok)
        resolve(result.value)
      else
        reject(result.error)
    }

    server.on('request', (req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (settled) {
        res.writeHead(409)
        res.end('Authorization already completed.')
        return
      }
      if (!URL.canParse(req.url || '/', 'http://127.0.0.1')) {
        res.writeHead(400)
        res.end('Invalid authorization URL.')
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== '/') {
        res.writeHead(404)
        res.end('Not found.')
        return
      }

      const state = url.searchParams.getAll('state')
      const receivedState = Buffer.from(state[0] ?? '')
      const expected = Buffer.from(expectedState)
      if (state.length !== 1 || receivedState.length !== expected.length || !timingSafeEqual(receivedState, expected)) {
        res.writeHead(400)
        res.end('Invalid authorization state. Use the URL shown in the terminal.')
        return
      }

      const codes = url.searchParams.getAll('code')
      const errors = url.searchParams.getAll('error')
      if (codes.length === 1 && codes[0] && errors.length === 0) {
        // Wait for the response to flush before closing loopback connections.
        res.once('finish', () => settle(ok({ code: codes[0]!, redirectUri: resolvedRedirectUri })))
        res.writeHead(200)
        res.end('Authorization successful. Close this window and return to the terminal.')
        return
      }
      if (errors.length === 1 && errors[0] && codes.length === 0) {
        const error: AuthError = errors[0] === 'access_denied'
          ? { kind: 'oauth-denied', message: 'Authorization denied. If you want to retry, run `gscdump auth login`.' }
          : { kind: 'oauth-failed', message: 'Authorization failed. Run `gscdump auth login` to retry.' }
        res.once('finish', () => settle(err(authErrorToException(error))))
        res.writeHead(400)
        res.end(error.message)
        return
      }

      res.writeHead(400)
      res.end('Invalid authorization response. Use the URL shown in the terminal.')
    })

    server.on('error', error => settle(err(error)))
    timeoutId = setTimeout(() => {
      settle(err(authErrorToException({
        kind: 'oauth-timed-out',
        message: 'Authorization timed out. Use a Desktop application OAuth client. Run `gscdump auth login` to retry.',
      })))
    }, 5 * 60 * 1000)

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        settle(err(new Error('Failed to start local server')))
        return
      }

      resolvedRedirectUri = `http://127.0.0.1:${addr.port}`
      authUrl.searchParams.set('redirect_uri', resolvedRedirectUri)
      const fullAuthUrl = authUrl.toString()

      console.log()
      if (noBrowser) {
        console.log('  Open this URL in your browser:')
      }
      else {
        console.log('  Opening browser for authorization...')
        console.log('  If the browser does not open, visit:')
      }
      console.log(`  ${fullAuthUrl}`)
      console.log()
      if (noBrowser) {
        console.log(`  If the CLI runs on another host, forward loopback port ${addr.port} before opening the URL.`)
        console.log(`  On your browser host, run: ssh -N -L ${addr.port}:127.0.0.1:${addr.port} user@host`)
        console.log('  Replace user@host with the CLI host. Keep this command running during login.')
        console.log()
      }
      console.log('  If Google reports redirect_uri_mismatch, use a Desktop application OAuth client.')
      console.log('  Create it at https://console.cloud.google.com/apis/credentials.')
      console.log('  Then run `gscdump init --force` with the new client credentials.')
      console.log()

      if (!noBrowser) {
        open(fullAuthUrl).catch(() => {
          logger.warn('Could not open browser automatically. Open the URL shown above.')
        })
      }
    })
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
  const env = resolveCliEnvironment()
  const envAccessToken = !opts.force ? env.accessToken : undefined
  const envRefreshToken = !opts.force ? env.refreshToken : undefined
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

  const savedTokens = !opts.force ? await loadTokens() : null
  const existingTokens = savedTokens?.provider === 'gscdump' ? null : savedTokens
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
    if (refreshFailed)
      throw new Error(`Token refresh failed${refreshError ? `: ${refreshError.message}` : ''}. The refresh token may be revoked or expired. Run \`gscdump auth login\` to sign in again.`)
    throw new Error(GOOGLE_NOT_CONNECTED)
  }

  const state = randomBytes(32).toString('base64url')
  const codeVerifier = randomBytes(32).toString('base64url')
  const authUrl = new URL(oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: CodeChallengeMethod.S256,
  }))

  logger.info('Waiting for authorization...')
  const { code, redirectUri } = await getAuthCodeViaLoopback(authUrl, state, Boolean(opts.noBrowser))

  const tokenClient = new OAuth2ClientClass(
    credentials.clientId,
    credentials.clientSecret,
    redirectUri,
  )
  const { tokens } = await tokenClient.getToken({ code, codeVerifier, redirect_uri: redirectUri })
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
  /** Print the loopback authorization URL without opening a browser. */
  noBrowser?: boolean
  /** Force a fresh OAuth flow even if env tokens / saved tokens exist. */
  force?: boolean
  /** Path to a service-account JSON key. Falls back to GOOGLE_APPLICATION_CREDENTIALS / GSC_SERVICE_ACCOUNT_JSON. */
  serviceAccount?: string
}

export async function getAuth(opts: GetAuthOptions = {}): Promise<OAuth2Client> {
  const { interactive = true, noBrowser = false, force = false } = opts
  const env = resolveCliEnvironment()
  const config = opts.config ?? await loadConfig()
  if ((env.clientId && env.clientSecret) || (config.clientId && config.clientSecret)) {
    const credentials = await getAuthCredentials(interactive)
    return authenticate(credentials, interactive, { noBrowser, force })
  }

  let tokens = force ? null : await loadTokens()
  if (tokens?.provider !== 'gscdump' || !tokens.refresh_token) {
    if (!interactive)
      throw new Error(GOOGLE_NOT_CONNECTED)
    tokens = await loginWithPlatform({
      force,
      request: fetch,
      now: Date.now,
      wait: waitForPoll,
      authorize: async (url) => {
        logger.info(`Open this URL to connect Google:\n${url}`)
        if (!noBrowser)
          await open(url).catch((error: Error) => logger.warn(`Browser could not open: ${error.message}. Open the URL above.`))
      },
    })
    await saveTokens(tokens)
  }
  const refreshToken = tokens.refresh_token!
  const client = new OAuth2ClientClass()
  // Google data calls stay direct. The platform only refreshes its own OAuth grant.
  client.refreshHandler = async () => {
    const refreshed = await refreshWithPlatform(refreshToken)
    await saveTokens({ provider: 'gscdump', refresh_token: refreshToken, ...refreshed })
    return refreshed
  }
  client.setCredentials({ access_token: tokens.access_token, expiry_date: tokens.expiry_date })
  await client.getAccessToken()
  return client
}

/**
 * Returns the right auth shape for `googleSearchConsole(auth)`. Priority:
 *   1. Explicit / env-configured service-account JSON (JWT)
 *   2. BYOK env vars
 *   3. Saved OAuth tokens / interactive loopback flow
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
  return pickCliEnvironmentValue(envVars)
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
  const env = resolveCliEnvironment()
  const saEnvPath = env.serviceAccountPath
  const saConfigPath = !saEnvPath ? (await loadConfig().catch(() => null))?.serviceAccountPath : undefined
  const saPath = saEnvPath || saConfigPath
  if (saEnvPath) {
    const saEnv = env.values.GSC_SERVICE_ACCOUNT_JSON ? 'GSC_SERVICE_ACCOUNT_JSON' : 'GOOGLE_APPLICATION_CREDENTIALS'
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

export type { GscdumpConfig }

/**
 * Which credential can reach Google without a sign-in, read from disk and
 * env only. It never calls Google, so a local read stays offline.
 */
export async function probeAuth(): Promise<'none' | 'google' | 'hosted'> {
  if ((await resolveAuthentication())._tag === 'Cloud')
    return 'hosted'
  if (resolveBYOK() || await resolveServiceAccount())
    return 'google'
  return (await loadTokens()) !== null ? 'google' : 'none'
}
