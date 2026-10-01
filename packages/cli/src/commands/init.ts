import type { OAuth2Client } from 'google-auth-library'
import process from 'node:process'
import { isCancel, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump/client'
import { ACCESS_NOT_SET_UP, getAuth, loadTokens, resolveBYOK, resolveServiceAccount } from '../auth'
import { saveAuthentication } from '../auth-state'
import { initCommandMeta } from '../command-meta'
import { defaultDataDir, loadConfig, saveConfig } from '../config'
import { useCliRuntime } from '../runtime'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'
import { loginHosted } from './auth'

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

export const initCommand = defineCommand({
  meta: initCommandMeta,
  args: {
    'force': {
      type: 'boolean',
      alias: 'f',
      description: 'Force re-initialization',
    },
    'store': {
      type: 'boolean',
      default: true,
      description: 'Ask where to keep the local Store',
      negativeDescription: 'Skip the Store location prompt (authentication only)',
    },
    'mode': {
      type: 'string',
      description: 'Access mode to save: local or hosted',
    },
    'api-key': {
      type: 'string',
      description: 'gscdump user API key for --mode hosted; defaults to GSCDUMP_API_KEY',
    },
    'api-root': {
      type: 'string',
      description: 'Hosted API root for --mode hosted; defaults to GSCDUMP_API_ROOT or https://gscdump.com/api',
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const config = await loadConfig()
    const mode = useCliRuntime().authModeOverride

    if (mode === 'hosted') {
      await loginHosted(args)
      printHostedNextSteps()
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

    // Environment shortcut: env vars already provide Google credentials, skip OAuth setup.
    const byok = resolveBYOK()
    if (byok) {
      // The credentials came from the environment, so nothing here needs a person.
      const dataDir = args.store ? config.dataDir ?? defaultDataDir() : config.dataDir
      await saveConfig({ ...config, ...(dataDir ? { dataDir } : {}) })
      await saveAuthentication({ _tag: 'Local' })
      logger.success(`Google credentials found in the environment (${typeof byok === 'string' ? 'access-token' : 'refresh-token'}). Login skipped.`)
      logger.success('Setup complete.')
      printNextSteps()
      return
    }

    // Service-account shortcut: the key file needs no login and never expires.
    const serviceAccount = await resolveServiceAccount().catch(() => null)
    if (serviceAccount) {
      const dataDir = args.store ? config.dataDir ?? defaultDataDir() : config.dataDir
      await saveConfig({ ...config, ...(dataDir ? { dataDir } : {}) })
      await saveAuthentication({ _tag: 'Local' })
      logger.success(`Service account found (${serviceAccount.email ?? 'key file'}). Login skipped.`)
      printNextSteps()
      return
    }

    if (!canPrompt()) {
      // No terminal: never prompt. Finish with saved tokens, or say which command to run.
      const tokens = await loadTokens()
      if (!tokens) {
        logger.error(`Init cannot prompt without a terminal.\n${ACCESS_NOT_SET_UP}`)
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

    const dataDir = args.store ? await promptDataDir(config.dataDir) : undefined
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
  const line = (command: string, note: string): void => console.log(`    ${command.padEnd(44)} # ${note}`)
  if (sites.length !== 1)
    line('gscdump sites', 'list your Sites')
  line(`gscdump sync --site ${site}`, 'fetch the last 28 days, then catch up on each run')
  line(`gscdump sync --status --site ${site}`, 'see what the Store holds')
  console.log()
}

/** Print the commands that come after Hosted setup. */
export function printHostedNextSteps(): void {
  console.log()
  console.log('  Next:')
  const line = (command: string, note: string): void => console.log(`    ${command.padEnd(44)} # ${note}`)
  line('gscdump sites', 'list your hosted Sites and their sync state')
  line('gscdump query --site <site> -d query', 'read the hosted record')
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
