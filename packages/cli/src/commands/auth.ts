import path from 'node:path'
import process from 'node:process'
import { isCancel, password } from '@clack/prompts'
import { defineCommand } from 'citty'
import { ofetch } from 'ofetch'
import { clearTokens, formatAuthProvenance, getAuth, loadServiceAccount, loadTokens, resolveBYOK, saveTokens } from '../auth'
import { missingRequiredScopes } from '../auth-scopes'
import { clearAuthentication, getCloudAccount, parseAuthentication, parseAuthMode, resolveAuthentication, saveAuthentication } from '../auth-state'
import { clearBingCredentials, getBingClient, inspectBingCredentials } from '../bing-auth'
import { authCommandMeta } from '../command-meta'
import { loadConfig, saveConfig } from '../config'
import { useCliRuntime } from '../runtime'
import { applyOutputMode, logger, noSubcommandSelected, OUTPUT_ARGS } from '../utils'
import { runSmokeTest } from './init'
import { adoptCurrentConfigAsProfile, profileNameFromEmail, resolveActiveProfile } from './profile'

const AUTH_SUBCOMMANDS = ['status', 'login', 'logout', 'refresh', 'scopes'] as const

const MODE_ARG = { type: 'string' as const, description: 'Authentication mode: cloud or local' }

function applyAuthMode(args: Record<string, unknown>): void {
  const mode = parseAuthMode(args.mode)
  if (mode)
    useCliRuntime().authModeOverride = mode
}

async function requireLocalAuth(args: Record<string, unknown>): Promise<void> {
  applyAuthMode(args)
  if ((await resolveAuthentication())._tag === 'Cloud')
    throw new Error('Cloud authentication uses an API key. OAuth scopes and token refresh require --mode local.')
}

async function loginCloud(args: Record<string, unknown>): Promise<void> {
  const env = useCliRuntime().environment
  let apiKey = String(args['api-key'] ?? env.GSCDUMP_API_KEY ?? '')
  if (!apiKey) {
    if (!process.stdin.isTTY)
      throw new Error('Cloud login requires --api-key or GSCDUMP_API_KEY.')
    const answer = await password({ message: 'gscdump user API key' })
    if (isCancel(answer) || typeof answer !== 'string')
      throw new Error('Login cancelled.')
    apiKey = answer
  }
  const state = parseAuthentication({
    _tag: 'Cloud',
    apiKey,
    apiRoot: String(args['api-root'] ?? env.GSCDUMP_API_ROOT ?? 'https://gscdump.com/api'),
  })
  if (state._tag !== 'Cloud')
    throw new Error('Cloud login requires a gscdump user API key.')
  const account = await getCloudAccount(state)
  await saveAuthentication(state)
  logger.success(`Cloud authentication saved for ${account.user.email}`)
  logger.info('Google and Bing commands use connections saved on gscdump.com.')
}

interface TokenInfo {
  scope?: string
  expires_in?: number
  email?: string
  audience?: string
}

async function fetchTokenInfo(accessToken: string): Promise<TokenInfo | null> {
  return ofetch<TokenInfo>('https://oauth2.googleapis.com/tokeninfo', {
    query: { access_token: accessToken },
  }).catch(() => null)
}

/**
 * Resolve the effective live access token (BYOK takes precedence over saved
 * tokens) and pull tokeninfo + parsed scopes + the missing-scopes diff.
 * Returns null token when nothing is configured.
 */
async function resolveLiveAuthState(): Promise<{
  byok: ReturnType<typeof resolveBYOK>
  tokens: Awaited<ReturnType<typeof loadTokens>>
  liveToken: string | null
  tokenInfo: TokenInfo | null
  scopes: string[]
  missing: string[]
}> {
  const tokens = await loadTokens()
  const byok = resolveBYOK()
  let liveToken: string | null = null
  if (typeof byok === 'string')
    liveToken = byok
  else if (byok && 'getAccessToken' in byok)
    liveToken = await byok.getAccessToken().then(r => r.token ?? null).catch(() => null)
  else if (tokens?.access_token)
    liveToken = tokens.access_token

  const tokenInfo = liveToken ? await fetchTokenInfo(liveToken) : null
  const scopes = tokenInfo?.scope ? tokenInfo.scope.split(/\s+/).filter(Boolean) : []
  const missing = missingRequiredScopes(scopes)

  return { byok, tokens, liveToken, tokenInfo, scopes, missing }
}

async function runStatus(args: Record<string, unknown>): Promise<void> {
  const { json } = applyOutputMode(args)
  applyAuthMode(args)
  const authentication = await resolveAuthentication()
  if (authentication._tag === 'Cloud') {
    const capabilities = {
      google: ['sites', 'query', 'sync', 'inspect', 'sitemaps', 'analyze', 'report'],
      bing: ['sites', 'dump', 'inspect', 'login', 'status', 'verify'],
      cloud: ['sitemaps current', 'sitemaps history', 'sitemaps membership', 'sitemaps lastmod', 'sitemaps export'],
      local: ['indexing', 'sites verification'],
    }
    // A hosted failure is a status result, not a command crash: report it
    // like the local branch reports a failed provider verification.
    const account = await getCloudAccount(authentication).then(
      value => ({ _tag: 'Ok' as const, value }),
      (error: unknown) => ({ _tag: 'Err' as const, detail: error instanceof Error ? error.message : 'Hosted authentication failed.' }),
    )
    if (account._tag === 'Err') {
      if (json) {
        console.log(JSON.stringify({ authenticated: false, mode: 'cloud', apiRoot: authentication.apiRoot, error: account.detail }, null, 2))
      }
      else {
        logger.warn(`Cloud status check failed: ${account.detail}`)
        logger.info(`API: ${authentication.apiRoot}`)
        logger.info('Fix connectivity or the API key, then run `gscdump auth status` again.')
      }
      return
    }
    if (json) {
      console.log(JSON.stringify({ authenticated: true, mode: 'cloud', account: account.value.user.email, apiRoot: authentication.apiRoot, sites: account.value.sites, capabilities }, null, 2))
    }
    else {
      logger.success(`Authenticated with cloud: ${account.value.user.email}`)
      console.log(`  API: ${authentication.apiRoot}`)
      console.log(`  Sites: ${account.value.sites.length}`)
      console.log('  Google and Bing use connections saved on gscdump.com.')
      console.log(`  Cloud commands: ${capabilities.cloud.join(', ')}`)
      console.log('  Google indexing and Site Verification require --mode local.')
    }
    return
  }
  const { byok, tokens, tokenInfo, scopes, missing } = await resolveLiveAuthState()
  const bingCredentials = await inspectBingCredentials()
  // A failed Bing token refresh or verification is a status result, not a
  // command crash: it surfaces as bing.authenticated false plus the
  // 'Bing credentials failed verification' warning below.
  const bingResult = bingCredentials._tag === 'Missing'
    ? null
    : await getBingClient()
        .then(client => client.getUserSites({ signal: AbortSignal.timeout(10_000) }))
        .catch(() => null)
  const bing = { configured: bingCredentials._tag !== 'Missing', authenticated: bingResult?.ok === true, source: bingCredentials._tag === 'Missing' ? null : bingCredentials._tag }
  const byokKind = byok
    ? typeof byok === 'string' ? 'access-token' : 'refresh-token'
    : null

  if (json) {
    console.log(JSON.stringify({
      authenticated: !!tokens || !!byok || bing.authenticated,
      mode: 'local',
      googleAuthenticated: !!tokens || !!byok,
      bing,
      source: byok ? 'byok' : tokens ? 'saved-tokens' : null,
      byokKind,
      scopes,
      tokenAccount: tokenInfo?.email ?? null,
      tokens: tokens
        ? {
            hasAccessToken: !!tokens.access_token,
            hasRefreshToken: !!tokens.refresh_token,
            expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
            expired: tokens.expiry_date ? tokens.expiry_date < Date.now() : null,
          }
        : null,
    }, null, 2))
    return
  }

  if (bing.authenticated)
    logger.success(`Bing authenticated locally (${bing.source})`)
  else if (bing.configured)
    logger.warn('Bing credentials failed verification. Run `gscdump bing login` again.')

  const reportScopes = (): void => {
    if (scopes.length === 0)
      return
    console.log(`  Scopes:`)
    for (const s of scopes)
      console.log(`    \x1B[90m└─\x1B[0m ${s}`)
    if (missing.length > 0) {
      console.log(`  \x1B[33mMissing scopes:\x1B[0m`)
      for (const s of missing)
        console.log(`    \x1B[90m└─\x1B[0m ${s}`)
      console.log(`  \x1B[90mRun \`gscdump auth login --force\` to re-consent.\x1B[0m`)
    }
  }

  if (byok) {
    logger.success(`Authenticated via BYOK (${byokKind})`)
    if (tokenInfo?.email)
      console.log(`  Account:       ${tokenInfo.email}`)
    reportScopes()
    return
  }

  if (!tokens) {
    if (bing.authenticated) {
      logger.info('Google credentials are missing. Run `gscdump auth login --mode local` to connect Google.')
      return
    }
    logger.warn('Not authenticated')
    logger.info('Run `gscdump init` (full setup) or `gscdump auth login` (OAuth only)')
    logger.info('Or set GSC_ACCESS_TOKEN / GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN env vars')
    return
  }

  const hasAccess = !!tokens.access_token
  const hasRefresh = !!tokens.refresh_token
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null
  const isExpired = expiry && expiry < new Date()

  if (isExpired && hasRefresh)
    logger.warn('Token expired; refresh available. Run `gscdump auth refresh`, or any live command will auto-refresh.')
  else if (isExpired)
    logger.error('Token expired and no refresh token present. Run `gscdump auth login`.')
  else
    logger.success('Authenticated (saved tokens)')
  console.log()
  console.log(`  Access token:  ${hasAccess ? '\x1B[32mpresent\x1B[0m' : '\x1B[31mmissing\x1B[0m'}`)
  console.log(`  Refresh token: ${hasRefresh ? '\x1B[32mpresent\x1B[0m' : '\x1B[31mmissing\x1B[0m'}`)
  if (expiry) {
    const status = isExpired ? '\x1B[33mexpired\x1B[0m' : '\x1B[32mvalid\x1B[0m'
    console.log(`  Expires:       ${expiry.toISOString()} (${status})`)
  }
  if (tokenInfo?.email)
    console.log(`  Account:       ${tokenInfo.email}`)
  reportScopes()
  if (isExpired && !hasRefresh)
    process.exit(1)
}

const statusCommand = defineCommand({
  meta: authCommandMeta.status,
  args: {
    ...OUTPUT_ARGS,
    mode: MODE_ARG,
  },
  async run({ args }) {
    await runStatus(args as Record<string, unknown>)
  },
})

const refreshCommand = defineCommand({
  meta: {
    name: 'refresh',
    description: 'Force-refresh saved OAuth tokens (no-op for BYOK)',
  },
  args: {
    ...OUTPUT_ARGS,
    mode: MODE_ARG,
  },
  async run({ args }) {
    applyOutputMode(args)
    await requireLocalAuth(args)
    if (resolveBYOK()) {
      logger.info('BYOK detected; refresh handled per-call by the SDK')
      return
    }
    const tokens = await loadTokens()
    if (!tokens?.refresh_token) {
      logger.error('No saved refresh token. Run `gscdump auth login`.')
      process.exit(1)
    }
    // Force expiry so authenticate() runs the refresh path.
    await saveTokens({ ...tokens, expiry_date: 1 })
    const client = await getAuth({ interactive: false }).catch((e: Error) => {
      logger.error(`Refresh failed: ${e.message}`)
      process.exit(1)
    })
    const refreshed = client.credentials
    if (refreshed?.access_token)
      logger.success('Token refreshed')
    else
      logger.warn('Refresh completed but no new access token returned')
  },
})

const loginCommand = defineCommand({
  meta: authCommandMeta.login,
  args: {
    ...OUTPUT_ARGS,
    'mode': MODE_ARG,
    'api-key': { type: 'string', description: 'gscdump user API key; defaults to GSCDUMP_API_KEY' },
    'api-root': { type: 'string', description: 'Cloud API root; defaults to GSCDUMP_API_ROOT or https://gscdump.com/api' },
    'force': { type: 'boolean', alias: 'f', default: false, description: 'Re-run OAuth even if tokens already exist' },
    'browser': { type: 'boolean', default: true, description: 'Open the authorization URL automatically. Pass --no-browser to open it yourself.' },
    'service-account': { type: 'string', description: 'Path to a service-account JSON key (skips OAuth)' },
  },
  async run({ args }) {
    applyOutputMode(args)
    const runtime = useCliRuntime()
    const requestedMode = parseAuthMode(args.mode) ?? runtime.authModeOverride ?? parseAuthMode(runtime.environment.GSCDUMP_AUTH_MODE)
    if (requestedMode === 'cloud' || (!requestedMode && (args['api-key'] || (await resolveAuthentication())._tag === 'Cloud'))) {
      await loginCloud(args)
      return
    }
    const byok = resolveBYOK()
    if (byok && !args.force) {
      await saveAuthentication({ _tag: 'Local' })
      logger.info('BYOK env vars detected, no login needed (--force to override)')
      return
    }
    // Service-account "login" is just persisting which file to use; tokens
    // are minted on-demand by the JWT client.
    if (args['service-account']) {
      const saPath = path.resolve(String(args['service-account']))
      const jwt = await loadServiceAccount(saPath).catch((e: Error) => {
        logger.error(`Service-account load failed: ${e.message}`)
        process.exit(1)
      })
      // Smoke-test the credentials by minting a token.
      await jwt.authorize().catch((e: Error) => {
        logger.error(`Service-account auth failed: ${e.message}`)
        process.exit(1)
      })
      const config = await loadConfig()
      config.serviceAccountPath = saPath
      await saveConfig(config)
      await saveAuthentication({ _tag: 'Local' })
      logger.success(`Service-account verified: ${(jwt as any).email ?? 'OK'}`)
      logger.info(`Saved path to config: ${saPath}`)
      return
    }
    const oauth = await getAuth({ interactive: true, noBrowser: args.browser === false, force: Boolean(args.force) }).catch((e: Error) => {
      logger.error(`Login failed: ${e.message}`)
      process.exit(1)
    })
    logger.success('Logged in')

    // Smoke-test: catch project-level misconfig (API not enabled, missing
    // scopes) here rather than letting the user discover it on first query.
    await runSmokeTest(oauth)
    await saveAuthentication({ _tag: 'Local' })

    // Auto-adopt: if no profile was active, derive one from the Google account
    // email so subsequent runs are scoped per-account without manual setup.
    if (!resolveActiveProfile()) {
      const tokens = await loadTokens()
      const info = tokens?.access_token ? await fetchTokenInfo(tokens.access_token) : null
      if (info?.email) {
        const name = profileNameFromEmail(info.email)
        const dir = await adoptCurrentConfigAsProfile(name).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn(`Login succeeded, but the config could not be moved into profile "${name}": ${message}`)
          return null
        })
        if (dir)
          logger.success(`Saved as profile "${name}" (active)`)
      }
    }

    // After login, show the full provenance breakdown — surfaces the common
    // footgun where stale BYOK env vars (from .env or shell) shadow the
    // tokens we just saved.
    if (resolveBYOK()) {
      console.log()
      console.log(await formatAuthProvenance())
    }
  },
})

const logoutCommand = defineCommand({
  meta: authCommandMeta.logout,
  args: {
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    await clearTokens()
    await clearBingCredentials()
    await clearAuthentication()
    const config = await loadConfig()
    if (config.serviceAccountPath) {
      delete config.serviceAccountPath
      await saveConfig(config)
      logger.info('Cleared saved service-account path')
    }
  },
})

const scopesCommand = defineCommand({
  meta: {
    name: 'scopes',
    description: 'Print granted OAuth scopes (one per line); exits 1 if any required scope is missing',
  },
  args: {
    ...OUTPUT_ARGS,
    mode: MODE_ARG,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    await requireLocalAuth(args)
    const { liveToken, scopes, missing } = await resolveLiveAuthState()

    if (!liveToken) {
      if (json) {
        console.log(JSON.stringify({ scopes: [], missing: null }, null, 2))
      }
      else {
        logger.error('Not authenticated')
      }
      process.exit(1)
    }

    if (json) {
      console.log(JSON.stringify({ scopes, missing }, null, 2))
    }
    else {
      for (const s of scopes)
        console.log(s)
    }
    if (missing.length > 0)
      process.exit(1)
  },
})

export const authCommand = defineCommand({
  meta: authCommandMeta.auth,
  args: {
    ...OUTPUT_ARGS,
    mode: MODE_ARG,
  },
  subCommands: {
    status: statusCommand,
    login: loginCommand,
    logout: logoutCommand,
    refresh: refreshCommand,
    scopes: scopesCommand,
  },
  // No subcommand: show status (the most common intent).
  async run({ args }) {
    if (!noSubcommandSelected('auth', AUTH_SUBCOMMANDS))
      return
    await runStatus(args as Record<string, unknown>)
  },
})

export { loginCommand, logoutCommand, statusCommand }
