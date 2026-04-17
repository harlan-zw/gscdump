import type { OAuth2Client } from 'google-auth-library'
import type { Credentials } from 'google-auth-library/build/src/auth/credentials.js'
import type { GscdumpConfig } from './config'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { isCancel, text } from '@clack/prompts'
import { OAuth2Client as OAuth2ClientClass } from 'google-auth-library'
import { getConfigDir, loadConfig } from './config'
import { logger } from './utils'

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
    logger.success('Using OAuth2 credentials from environment')
    return { clientId: envClientId, clientSecret: envClientSecret }
  }

  const config = await loadConfig()
  if (config.clientId && config.clientSecret) {
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

    const server = createServer((req, res) => {
      const url = new URL(req.url || '', `http://127.0.0.1`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h1>Authorization Failed</h1><p>${error}</p><p>You can close this window.</p></body></html>`)
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h1>Authorization Successful</h1><p>You can close this window and return to the terminal.</p></body></html>`)
        server.close()
        resolve({ code, redirectUri: resolvedRedirectUri })
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(`<html><body><h1>Missing authorization code</h1></body></html>`)
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start local server'))
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

      import('open').then(({ default: open }) => open(fullAuthUrl)).catch(() => {
        logger.warn('Could not open browser automatically')
      })
    })

    server.on('error', reject)

    setTimeout(() => {
      server.close()
      reject(new Error('Authorization timed out'))
    }, 5 * 60 * 1000)
  })
}

export async function authenticate(credentials: OAuth2Credentials, interactive: boolean): Promise<OAuth2Client> {
  const oauth2Client = new OAuth2ClientClass(
    credentials.clientId,
    credentials.clientSecret,
    'http://127.0.0.1',
  )

  const envAccessToken = process.env.GOOGLE_ACCESS_TOKEN
  const envRefreshToken = process.env.GOOGLE_REFRESH_TOKEN
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

  const existingTokens = await loadTokens()
  if (existingTokens) {
    oauth2Client.setCredentials(existingTokens)

    if (existingTokens.expiry_date && existingTokens.expiry_date < Date.now()) {
      const { credentials: newTokens } = await oauth2Client.refreshAccessToken()
        .catch(() => ({ credentials: null }))

      if (newTokens) {
        await saveTokens(newTokens)
        oauth2Client.setCredentials(newTokens)
        logger.success('Token refreshed')
        return oauth2Client
      }
    }
    else {
      logger.success('Using saved credentials')
      return oauth2Client
    }
  }

  if (!interactive) {
    logger.error('No saved tokens. Run interactively first to authenticate.')
    process.exit(1)
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/indexing',
    ],
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
  logger.success(`Tokens saved to ${getTokensPath()}`)

  return oauth2Client
}

export interface GetAuthOptions {
  interactive?: boolean
  config?: GscdumpConfig
}

export async function getAuth(opts: GetAuthOptions = {}): Promise<OAuth2Client> {
  const { interactive = true } = opts
  const credentials = await getAuthCredentials(interactive)
  return authenticate(credentials, interactive)
}

export type { GscdumpConfig }
