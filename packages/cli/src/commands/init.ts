import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isCancel, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { authenticate, getAuthCredentials, saveTokens } from '../auth'
import { defaultDataDir, loadConfig, saveConfig } from '../config'
import { logger } from '../utils'

const ENV_LINE_RE = /^([^=]+)=(.*)$/

async function promptDataDir(existing?: string): Promise<string> {
  const fallback = existing ?? defaultDataDir()
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
  meta: {
    name: 'init',
    description: 'Set up GSCDump authentication',
  },
  args: {
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Force re-initialization',
    },
  },
  async run({ args }) {
    const config = await loadConfig()

    if (config.clientId && config.clientSecret && !args.force) {
      logger.info('Already configured')
      logger.info('Run with --force to reconfigure')
      return
    }

    const envFile = await loadEnvFile()
    if (envFile?.GOOGLE_CLIENT_ID && envFile?.GOOGLE_CLIENT_SECRET && envFile?.GOOGLE_REFRESH_TOKEN) {
      logger.info('Found .env file with Google credentials')

      process.env.GOOGLE_CLIENT_ID = envFile.GOOGLE_CLIENT_ID
      process.env.GOOGLE_CLIENT_SECRET = envFile.GOOGLE_CLIENT_SECRET
      process.env.GOOGLE_REFRESH_TOKEN = envFile.GOOGLE_REFRESH_TOKEN
      if (envFile.GOOGLE_ACCESS_TOKEN)
        process.env.GOOGLE_ACCESS_TOKEN = envFile.GOOGLE_ACCESS_TOKEN

      await saveConfig({
        ...config,
        clientId: envFile.GOOGLE_CLIENT_ID,
        clientSecret: envFile.GOOGLE_CLIENT_SECRET,
        dataDir: config.dataDir ?? defaultDataDir(),
      })

      const auth = await authenticate({ clientId: envFile.GOOGLE_CLIENT_ID, clientSecret: envFile.GOOGLE_CLIENT_SECRET }, false)

      const creds = auth.credentials
      if (creds.access_token) {
        await saveTokens({
          access_token: creds.access_token,
          refresh_token: creds.refresh_token || envFile.GOOGLE_REFRESH_TOKEN,
          expiry_date: creds.expiry_date,
        })
      }

      console.log()
      logger.success('Setup complete using .env credentials! Run gscdump to get started.')
      return
    }

    console.log()
    console.log('  \x1B[1mWelcome to GSCDump!\x1B[0m')
    console.log('  \x1B[90mGoogle Search Console data extraction CLI\x1B[0m')
    console.log()

    const dataDir = await promptDataDir(config.dataDir)
    const credentials = await getAuthCredentials(true)
    await saveConfig({
      ...config,
      dataDir,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })
    await authenticate(credentials, true)

    console.log()
    logger.success('Setup complete! Run gscdump to get started.')
  },
})
