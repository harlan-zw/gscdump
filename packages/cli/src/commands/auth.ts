import process from 'node:process'
import { defineCommand } from 'citty'
import { ofetch } from 'ofetch'
import { authenticate, clearTokens, formatAuthProvenance, getAuth, getAuthCredentials, loadServiceAccount, loadTokens, resolveBYOK, saveTokens } from '../auth'
import { logger, setQuiet } from '../utils'

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

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current authentication status',
  },
  args: {
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const tokens = await loadTokens()
    const byok = resolveBYOK()
    const byokKind = byok
      ? typeof byok === 'string' ? 'access-token' : 'refresh-token'
      : null

    // Resolve a live access token to query tokeninfo for scopes.
    let liveToken: string | null = null
    if (typeof byok === 'string') {
      liveToken = byok
    }
    else if (byok && 'getAccessToken' in byok) {
      liveToken = await byok.getAccessToken().then(r => r.token ?? null).catch(() => null)
    }
    else if (tokens?.access_token) {
      liveToken = tokens.access_token
    }
    const tokenInfo = liveToken ? await fetchTokenInfo(liveToken) : null
    const scopes = tokenInfo?.scope ? tokenInfo.scope.split(/\s+/).filter(Boolean) : []

    if (args.json) {
      console.log(JSON.stringify({
        authenticated: !!tokens || !!byok,
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

    const reportScopes = (): void => {
      if (scopes.length === 0)
        return
      console.log(`  Scopes:`)
      const required = [
        'https://www.googleapis.com/auth/webmasters',
        'https://www.googleapis.com/auth/indexing',
        'https://www.googleapis.com/auth/siteverification',
      ]
      const has = (s: string): boolean => scopes.includes(s) || scopes.includes(s.replace('.readonly', ''))
      for (const s of scopes)
        console.log(`    \x1B[90m└─\x1B[0m ${s}`)
      const missing = required.filter(s => !has(s))
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
      logger.warn('Not authenticated')
      logger.info('Run `gscdump init` (full setup) or `gscdump auth login` (OAuth only)')
      logger.info('Or set GSC_ACCESS_TOKEN / GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN env vars')
      return
    }

    const hasAccess = !!tokens.access_token
    const hasRefresh = !!tokens.refresh_token
    const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null
    const isExpired = expiry && expiry < new Date()

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
  },
})

const refreshCommand = defineCommand({
  meta: {
    name: 'refresh',
    description: 'Force-refresh saved OAuth tokens (no-op for BYOK)',
  },
  args: {
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet))
    if (resolveBYOK()) {
      logger.info('BYOK detected; refresh handled per-call by the SDK')
      return
    }
    const tokens = await loadTokens()
    if (!tokens?.refresh_token) {
      logger.error('No saved refresh token. Run `gscdump auth login`.')
      process.exit(1)
    }
    const credentials = await getAuthCredentials(false).catch((e: Error) => {
      logger.error(`Cannot resolve credentials: ${e.message}`)
      process.exit(1)
    })
    // Force expiry so authenticate() runs the refresh path.
    await saveTokens({ ...tokens, expiry_date: 1 })
    const client = await authenticate(credentials, false).catch((e: Error) => {
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
  meta: {
    name: 'login',
    description: 'Run OAuth flow and persist tokens (skip if BYOK env vars set)',
  },
  args: {
    'force': { type: 'boolean', alias: 'f', default: false, description: 'Re-run OAuth even if tokens already exist' },
    'browser': { type: 'boolean', default: true, description: 'Use loopback browser flow. Pass --no-browser for device-code (headless).' },
    'service-account': { type: 'string', description: 'Path to a service-account JSON key (skips OAuth)' },
    'quiet': { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet))
    const byok = resolveBYOK()
    if (byok && !args.force) {
      logger.info('BYOK env vars detected, no login needed (--force to override)')
      return
    }
    // Service-account "login" is just persisting which file to use; tokens
    // are minted on-demand by the JWT client.
    if (args['service-account']) {
      const jwt = await loadServiceAccount(String(args['service-account'])).catch((e: Error) => {
        logger.error(`Service-account load failed: ${e.message}`)
        process.exit(1)
      })
      // Smoke-test the credentials by minting a token.
      await jwt.authorize().catch((e: Error) => {
        logger.error(`Service-account auth failed: ${e.message}`)
        process.exit(1)
      })
      logger.success(`Service-account verified: ${(jwt as any).email ?? 'OK'}`)
      logger.info(`Set GOOGLE_APPLICATION_CREDENTIALS=${args['service-account']} to use it across sessions.`)
      return
    }
    if (args.force)
      await clearTokens()
    await getAuth({ interactive: true, noBrowser: args.browser === false, force: Boolean(args.force) }).catch((e: Error) => {
      logger.error(`Login failed: ${e.message}`)
      process.exit(1)
    })
    logger.success('Logged in')
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
  meta: {
    name: 'logout',
    description: 'Clear stored OAuth tokens',
  },
  args: {
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet))
    await clearTokens()
  },
})

export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Manage authentication',
  },
  subCommands: {
    status: statusCommand,
    login: loginCommand,
    logout: logoutCommand,
    refresh: refreshCommand,
  },
})
