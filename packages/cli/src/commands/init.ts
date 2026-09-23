import type { OAuth2Client } from 'google-auth-library'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { confirm, isCancel, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump/client'
import { authenticate, getAuth, loadTokens, resolveBYOK, saveTokens } from '../auth'
import { saveAuthentication } from '../auth-state'
import { initCommandMeta } from '../command-meta'
import { defaultDataDir, loadConfig, saveConfig } from '../config'
import { applyCliEnvironment } from '../environment'
import { useCliRuntime } from '../runtime'
import { applyOutputMode, displayPath, logger, OUTPUT_ARGS } from '../utils'
import { loginCloud } from './auth'

const ENV_LINE_RE = /^([^=]+)=(.*)$/

/** True when a person can answer prompts. Pipes, cron, and agents cannot. */
function canPrompt(): boolean {
  return process.stdin.isTTY === true
}

async function promptDataDir(existing?: string): Promise<string> {
  const fallback = existing ?? defaultDataDir()
  if (!canPrompt())
    return fallback
  const answer = await text({
    message: 'Where should Parquet data be stored?',
    placeholder: fallback,
    defaultValue: fallback,
  })
  if (isCancel(answer))
    process.exit(1)
  return String(answer) || fallback
}

async function loadEnvFile(): Promise<Record<string, string> | null> {
  const envPath = path.join(process.cwd(), '.env')
  const content = await fs.readFile(envPath, 'utf-8').catch(() => null)
  if (!content)
    return null

  const env: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    const match = trimmed.match(ENV_LINE_RE)
    if (match) {
      const key = match[1].trim()
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))
        value = value.slice(1, -1)
      env[key] = value
    }
  }
  return env
}

export const initCommand = defineCommand({
  meta: initCommandMeta,
  args: {
    'force': {
      type: 'boolean',
      alias: 'f',
      description: 'Force re-initialization',
    },
    'no-store': {
      type: 'boolean',
      default: false,
      description: 'Skip dataDir prompt (auth-only setup)',
    },
    'mode': {
      type: 'string',
      description: 'Authentication mode to save: cloud or local',
    },
    'api-key': {
      type: 'string',
      description: 'gscdump user API key for --mode cloud; defaults to GSCDUMP_API_KEY',
    },
    'api-root': {
      type: 'string',
      description: 'Cloud API root for --mode cloud; defaults to GSCDUMP_API_ROOT or https://gscdump.com/api',
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const config = await loadConfig()
    const mode = useCliRuntime().authModeOverride

    if (mode === 'cloud') {
      await loginCloud(args)
      printNextSteps()
      return
    }

    if (config.clientId && config.clientSecret && !args.force) {
      logger.info('Already configured')
      const tokens = await loadTokens()
      if (!tokens) {
        logger.info('No saved tokens. Run `gscdump auth login` to authenticate.')
      }
      else {
        const isExpired = tokens.expiry_date && tokens.expiry_date < Date.now()
        if (isExpired && tokens.refresh_token)
          logger.info('Tokens expired but refresh available. Any live command will auto-refresh, or run `gscdump auth refresh`.')
        else if (isExpired)
          logger.warn('Tokens expired without a refresh token. Run `gscdump auth login` to re-authenticate.')
      }
      if (mode === 'local')
        await saveAuthentication({ _tag: 'Local' })
      logger.info('Run `gscdump init --force` to reconfigure.')
      printNextSteps()
      return
    }

    // BYOK shortcut: env vars already provide credentials, skip OAuth setup.
    const byok = resolveBYOK()
    if (byok) {
      // The credentials came from the environment, so nothing here needs a person.
      const dataDir = args['no-store'] ? config.dataDir : config.dataDir ?? defaultDataDir()
      await saveConfig({ ...config, ...(dataDir ? { dataDir } : {}) })
      await saveAuthentication({ _tag: 'Local' })
      logger.success(`BYOK detected (${typeof byok === 'string' ? 'access-token' : 'refresh-token'}). Auth setup skipped.`)
      logger.success('Setup complete.')
      printNextSteps()
      return
    }

    // .env shortcut: pick up credentials from a project-local .env file.
    const envFile = await loadEnvFile()
    const envCid = envFile?.GSC_CLIENT_ID ?? envFile?.GOOGLE_CLIENT_ID
    const envSec = envFile?.GSC_CLIENT_SECRET ?? envFile?.GOOGLE_CLIENT_SECRET
    const envRef = envFile?.GSC_REFRESH_TOKEN ?? envFile?.GOOGLE_REFRESH_TOKEN
    const envAcc = envFile?.GSC_ACCESS_TOKEN ?? envFile?.GOOGLE_ACCESS_TOKEN
    if (envCid && envSec && envRef) {
      logger.info('Found .env file with credentials')

      applyCliEnvironment({
        GOOGLE_ACCESS_TOKEN: envAcc,
        GOOGLE_CLIENT_ID: envCid,
        GOOGLE_CLIENT_SECRET: envSec,
        GOOGLE_REFRESH_TOKEN: envRef,
      })

      await saveConfig({
        ...config,
        clientId: envCid,
        clientSecret: envSec,
        dataDir: config.dataDir ?? defaultDataDir(),
      })

      const auth = await authenticate({ clientId: envCid, clientSecret: envSec }, false)

      const creds = auth.credentials
      if (creds.access_token) {
        await saveTokens({
          access_token: creds.access_token,
          refresh_token: creds.refresh_token || envRef,
          expiry_date: creds.expiry_date,
        })
      }

      await saveAuthentication({ _tag: 'Local' })
      console.log()
      logger.success('Setup complete using .env credentials.')
      printNextSteps()
      return
    }

    if (!canPrompt()) {
      // No terminal: never prompt. Finish with saved tokens, or say which command to run.
      const tokens = await loadTokens()
      if (!tokens) {
        logger.error([
          'No Google credentials found. Init cannot prompt without a terminal.',
          'Run `gscdump auth login` in a terminal, or set GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN.',
          'To use gscdump.com, run `gscdump init --mode cloud --api-key <key>`.',
        ].join('\n'))
        process.exit(1)
      }
      await saveConfig({ ...config, dataDir: config.dataDir ?? defaultDataDir() })
      await saveAuthentication({ _tag: 'Local' })
      logger.success('Setup complete with the saved Google login.')
      printNextSteps()
      return
    }

    console.log()
    console.log('  \x1B[1mWelcome to GSCDump!\x1B[0m')
    console.log('  \x1B[90mGoogle Search Console data extraction CLI\x1B[0m')
    console.log()

    const dataDir = args['no-store'] ? undefined : await promptDataDir(config.dataDir)
    await saveConfig({
      ...config,
      ...(dataDir ? { dataDir } : {}),
    })
    const oauth = await getAuth({ interactive: true })

    // Smoke-test the new credentials by listing sites. Catches missing scopes
    // (e.g., user enabled Search Console API but didn't tick the indexing
    // scope) before the user runs an unrelated command and gets a 403 they
    // can't immediately attribute.
    const sites = await runSmokeTest(oauth)
    await saveAuthentication({ _tag: 'Local' })

    if (config.clientId && config.clientSecret)
      await maybeWriteEnvFile(config.clientId, config.clientSecret)

    console.log()
    logger.success('Setup complete.')
    printNextSteps(sites)
  },
})

/** Print the exact commands that come after setup. */
export function printNextSteps(sites: readonly string[] = []): void {
  const site = sites.length === 1 ? sites[0] : '<site>'
  console.log()
  console.log('  Next:')
  if (sites.length !== 1)
    console.log('    gscdump sites                     # list your Sites')
  console.log(`    gscdump sync --site ${site}   # fetch the last 28 days, then catch up on each run`)
  console.log(`    gscdump sync --status --site ${site}`)
  console.log()
}

/**
 * Hit `sites.list` as a post-auth health check. Surfaces project-level
 * misconfig (Search Console API not enabled, missing scopes) with an
 * actionable next step, since those errors won't appear until the first real
 * API call otherwise.
 */
export async function runSmokeTest(oauth: OAuth2Client): Promise<string[]> {
  const client = googleSearchConsole(oauth)
  const sites = await client.sites().catch((e: Error) => e)
  if (sites instanceof Error) {
    const msg = sites.message
    const apiDisabledMatch = msg.match(/projects?\/(\d+)/) ?? msg.match(/project (\d+)/)
    if (/has not been used in project|API has not been used|SERVICE_DISABLED/i.test(msg)) {
      logger.error('Search Console API is not enabled for this Google Cloud project.')
      const project = apiDisabledMatch?.[1]
      const url = project
        ? `https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=${project}`
        : 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview'
      logger.info(`Enable it here, then retry: ${url}`)
      logger.info('Note: it can take a few minutes to propagate after enabling.')
      return []
    }
    if (/insufficient|scope|forbidden|403/i.test(msg)) {
      logger.warn(`Smoke test failed (likely missing scopes): ${msg}`)
      logger.info('Run `gscdump auth login --force` to re-consent with the required scopes.')
      return []
    }
    logger.warn(`Smoke test failed: ${msg}`)
    logger.info('Auth saved, but verify via `gscdump auth status` / `gscdump doctor`.')
    return []
  }
  logger.success(`Verified: ${sites.length} GSC site(s) accessible`)
  return sites.flatMap(site => site.siteUrl ? [site.siteUrl] : [])
}

async function maybeWriteEnvFile(clientId: string, clientSecret: string): Promise<void> {
  const tokens = await loadTokens()
  if (!tokens?.refresh_token)
    return
  const wants = await confirm({
    message: 'Write a `.env` file with these credentials? (handy for CI / other machines)',
    initialValue: false,
  })
  if (isCancel(wants) || !wants)
    return
  const envPath = path.join(process.cwd(), '.env')
  const exists = await fs.stat(envPath).then(() => true).catch(() => false)
  if (exists) {
    const overwrite = await confirm({
      message: `${displayPath(envPath)} exists. Overwrite?`,
      initialValue: false,
    })
    if (isCancel(overwrite) || !overwrite) {
      logger.info(`Skipped — keep credentials at ${displayPath(envPath)} manually if needed`)
      return
    }
  }
  const content = [
    `GSC_CLIENT_ID=${clientId}`,
    `GSC_CLIENT_SECRET=${clientSecret}`,
    `GSC_REFRESH_TOKEN=${tokens.refresh_token}`,
    '',
  ].join('\n')
  await fs.writeFile(envPath, content, { mode: 0o600 })
  logger.success(`Wrote ${displayPath(envPath)}`)
}
