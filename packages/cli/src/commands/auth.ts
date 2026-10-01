import type { TokenInfo } from '../token-info'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as waitForPoll } from 'node:timers/promises'
import { defineCommand } from 'citty'
import open from 'open'
import { ACCESS_NOT_SET_UP, clearTokens, formatAuthProvenance, getAuth, loadServiceAccount, loadTokens, resolveBYOK, saveTokens } from '../auth'
import { missingRequiredScopes } from '../auth-scopes'
import { clearAuthentication, formatHostedSync, getHostedAccount, parseAuthentication, parseAuthMode, resolveAuthentication, revokeHostedSession, saveAuthentication } from '../auth-state'
import { clearBingCredentials, getBingClient, inspectBingCredentials } from '../bing-auth'
import { authCommandMeta } from '../command-meta'
import { loadConfig, saveConfig } from '../config'
import { loginWithHostedSession } from '../hosted-auth'
import { useCliRuntime } from '../runtime'
import { currentAccessToken, fetchTokenInfo, redactTokens } from '../token-info'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'
import { runSmokeTest } from './init'
import { adoptCurrentConfigAsProfile, profileNameFromEmail, resolveActiveProfile } from './profile'

const MODE_ARG = { type: 'string' as const, description: 'Access mode: local or hosted' }

function applyAuthMode(args: Record<string, unknown>): void {
  const mode = parseAuthMode(args.mode)
  if (mode)
    useCliRuntime().authModeOverride = mode
}

async function requireLocalAuth(args: Record<string, unknown>): Promise<void> {
  applyAuthMode(args)
  if ((await resolveAuthentication())._tag === 'Hosted')
    throw new Error('Google scopes and token refresh apply to Local mode only. Hosted mode uses a gscdump.com CLI session.')
}

const HOSTED_MODE_NOTE = 'Hosted mode reads your gscdump.com record. Commands that call Google need Local mode.'

/** What Hosted mode can run. Every other Google command needs Local mode. */
export const HOSTED_COMMANDS = [
  'sites',
  'query',
  'sitemaps current',
  'sitemaps history',
  'sitemaps membership',
  'sitemaps lastmod',
  'sitemaps export',
  'indexing urls',
  'indexing summary',
  'indexing watch',
  'bing login',
  'bing sites',
  'bing status',
  'bing dump',
  'bing inspect',
  'bing verify',
] as const

export async function loginHosted(args: Record<string, unknown>): Promise<void> {
  const env = useCliRuntime().environment
  const apiKey = String(args['api-key'] ?? env.GSCDUMP_API_KEY ?? '')
  const apiRoot = String(args['api-root'] ?? env.GSCDUMP_API_ROOT ?? 'https://gscdump.com/api')
  if (!apiKey) {
    if (apiRoot.replace(/\/+$/, '') !== 'https://gscdump.com/api')
      throw new Error('Browser login uses gscdump.com. Supply --api-key for a custom API root.')
    const sessionId = await loginWithHostedSession({
      request: fetch,
      now: Date.now,
      wait: waitForPoll,
      authorize: async (url) => {
        logger.info(`Open this URL to link the CLI to gscdump.com:\n${url}`)
        if (args.browser !== false)
          await open(url).catch((error: Error) => logger.warn(`Browser could not open: ${error.message}. Open the URL above.`))
      },
    })
    const state = parseAuthentication({ _tag: 'Hosted', apiRoot, sessionId })
    if (state._tag !== 'Hosted')
      throw new Error('Hosted login did not return a CLI session.')
    const account = await getHostedAccount(state)
    await saveAuthentication(state)
    logger.success(`Hosted mode saved for ${account.user.email}`)
    logger.info(HOSTED_MODE_NOTE)
    return
  }
  const state = parseAuthentication({
    _tag: 'Hosted',
    apiKey,
    apiRoot,
  })
  if (state._tag !== 'Hosted')
    throw new Error('Hosted login needs a gscdump user API key.')
  const account = await getHostedAccount(state)
  await saveAuthentication(state)
  logger.success(`Hosted mode saved for ${account.user.email}`)
  logger.info(HOSTED_MODE_NOTE)
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
  /** Set only when Google confirmed the token. */
  tokenInfo: TokenInfo | null
  /** Why the credentials failed verification, or null. */
  failure: string | null
  scopes: string[]
  missing: string[]
}> {
  const tokens = await loadTokens()
  const byok = resolveBYOK()
  // Refresh saved credentials first: an expired saved token would fail
  // tokeninfo even though the credentials still work.
  const source = byok ?? (tokens ? await getAuth({ interactive: false }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))) : null)
  const current = source === null
    ? null
    : source instanceof Error
      ? { kind: 'failed' as const, detail: redactTokens(source.message) }
      : await currentAccessToken(source)
  const liveToken = current?.kind === 'token' ? current.token : null
  const verified = liveToken ? await fetchTokenInfo(liveToken) : null
  const tokenInfo = verified?.kind === 'valid' ? verified.info : null
  const failure = current?.kind === 'failed' ? current.detail : verified?.kind === 'invalid' ? verified.detail : null
  const scopes = tokenInfo?.scope ? tokenInfo.scope.split(/\s+/).filter(Boolean) : []
  const missing = missingRequiredScopes(scopes)
  // A refresh above may have saved new tokens; report those.
  const savedTokens = tokens && !byok ? await loadTokens() : tokens

  return { byok, tokens: savedTokens, liveToken, tokenInfo, failure, scopes, missing }
}

async function runStatus(args: Record<string, unknown>): Promise<void> {
  const { json } = applyOutputMode(args)
  applyAuthMode(args)
  const authentication = await resolveAuthentication()
  if (authentication._tag === 'Hosted') {
    // A hosted failure is a status result, not a command crash: report it
    // like the local branch reports a failed provider verification.
    const account = await getHostedAccount(authentication).then(
      value => ({ _tag: 'Ok' as const, value }),
      (error: unknown) => ({ _tag: 'Err' as const, detail: error instanceof Error ? error.message : 'Hosted credentials failed.' }),
    )
    if (account._tag === 'Err') {
      if (json) {
        console.log(JSON.stringify({ authenticated: false, mode: 'hosted', apiRoot: authentication.apiRoot, error: account.detail }, null, 2))
      }
      else {
        logger.warn(`Hosted status check failed: ${account.detail}`)
        logger.info(`API: ${authentication.apiRoot}`)
        logger.info('Fix connectivity or the API key, then run `gscdump auth status` again.')
      }
      return
    }
    const sites = account.value.sites
    if (json) {
      console.log(JSON.stringify({
        authenticated: true,
        mode: 'hosted',
        account: account.value.user.email,
        apiRoot: authentication.apiRoot,
        sites: sites.map(site => ({ siteId: site.siteId, siteUrl: site.siteUrl })),
        hostedSync: sites.map(site => ({ siteUrl: site.siteUrl, syncStatus: site.syncStatus ?? null, syncProgress: site.syncProgress ?? null, oldestDateSynced: site.oldestDateSynced ?? null, newestDateSynced: site.newestDateSynced ?? null })),
        commands: HOSTED_COMMANDS,
      }, null, 2))
    }
    else {
      logger.success(`Hosted mode: ${account.value.user.email}`)
      console.log(`  API: ${authentication.apiRoot}`)
      console.log(`  Sites: ${sites.length}`)
      for (const site of sites)
        console.log(`    ${site.siteUrl}  ${formatHostedSync(site)}`)
      console.log(`  ${HOSTED_MODE_NOTE}`)
      console.log(`  Hosted commands: ${HOSTED_COMMANDS.join(', ')}`)
    }
    return
  }
  const { byok, tokens, tokenInfo, failure, scopes, missing } = await resolveLiveAuthState()
  const googleAuthenticated = tokenInfo !== null
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
      authenticated: googleAuthenticated || bing.authenticated,
      mode: 'local',
      googleAuthenticated,
      googleError: failure,
      bing,
      source: byok ? 'env' : tokens ? 'saved-tokens' : null,
      envCredential: byokKind,
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
    if (googleAuthenticated)
      logger.success(`Authenticated with environment credentials (${byokKind})`)
    else
      logger.warn(`Environment credentials (${byokKind}) failed verification: ${failure}`)
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
    logger.warn(ACCESS_NOT_SET_UP)
    return
  }

  const hasAccess = !!tokens.access_token
  const hasRefresh = !!tokens.refresh_token
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null
  const isExpired = expiry && expiry < new Date()

  if (googleAuthenticated)
    logger.success('Authenticated (saved tokens)')
  else
    logger.warn(`Saved credentials failed verification: ${failure}. Run \`gscdump auth login\` to sign in again.`)
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
    description: 'Force-refresh saved OAuth tokens (no-op for environment credentials)',
  },
  args: {
    ...OUTPUT_ARGS,
    mode: MODE_ARG,
  },
  async run({ args }) {
    applyOutputMode(args)
    await requireLocalAuth(args)
    if (resolveBYOK()) {
      logger.info('Environment credentials found. The SDK refreshes them for each call.')
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
    'api-key': { type: 'string', description: 'gscdump user API key for Hosted mode; defaults to GSCDUMP_API_KEY' },
    'api-root': { type: 'string', description: 'Hosted API root; defaults to GSCDUMP_API_ROOT or https://gscdump.com/api' },
    'force': { type: 'boolean', alias: 'f', default: false, description: 'Re-run OAuth even if tokens already exist' },
    'browser': { type: 'boolean', default: true, description: 'Open the authorization URL automatically. Pass --no-browser to open it yourself.' },
    'service-account': { type: 'string', description: 'Path to a service-account JSON key (skips OAuth)' },
  },
  async run({ args }) {
    applyOutputMode(args)
    const runtime = useCliRuntime()
    const requestedMode = parseAuthMode(args.mode) ?? runtime.authModeOverride ?? parseAuthMode(runtime.environment.GSCDUMP_AUTH_MODE)
    if (requestedMode === 'hosted' || (!requestedMode && (args['api-key'] || (await resolveAuthentication())._tag === 'Hosted'))) {
      await loginHosted(args)
      return
    }
    const byok = resolveBYOK()
    if (byok && !args.force) {
      await saveAuthentication({ _tag: 'Local' })
      logger.info('Google credentials found in the environment. No login is needed. Pass --force to log in again.')
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
      const verified = tokens?.access_token ? await fetchTokenInfo(tokens.access_token) : null
      if (verified?.kind === 'valid' && verified.info.email) {
        const name = profileNameFromEmail(verified.info.email)
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
    // footgun where stale BYOK environment variables shadow the
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
    // Revocation is best-effort: an offline host, a 5xx, an already-revoked
    // session, or unreadable saved state must never leave local credentials
    // on disk. Local state is cleared unconditionally below.
    await resolveAuthentication()
      .then(authentication => authentication._tag === 'Hosted' ? revokeHostedSession(authentication) : undefined)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`Hosted session revocation failed (${message}). Saved credentials are still cleared.`)
      })
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
    await runStatus(args as Record<string, unknown>)
  },
})

export { loginCommand, logoutCommand, statusCommand }
