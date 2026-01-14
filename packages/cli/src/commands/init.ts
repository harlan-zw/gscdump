import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { authenticate, authenticateCloud, getAuthCredentials, saveTokens } from '../auth'
import { DEFAULT_CLOUD_URL, loadConfig, saveConfig } from '../config'
import { logger } from '../utils'

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
    const match = trimmed.match(/^([^=]+)=(.*)$/)
    if (match) {
      const key = match[1].trim()
      let value = match[2].trim()
      // Remove quotes
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
    description: 'Set up GSCDump (choose cloud or local mode)',
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

    if (config.mode && !args.force) {
      logger.info(`Already configured in ${config.mode} mode`)
      logger.info('Run with --force to reconfigure')
      return
    }

    // Check for .env file with tokens
    const envFile = await loadEnvFile()
    if (envFile?.GOOGLE_CLIENT_ID && envFile?.GOOGLE_CLIENT_SECRET && envFile?.GOOGLE_REFRESH_TOKEN) {
      logger.info('Found .env file with Google credentials')

      // Set env vars so authenticate() can use them
      process.env.GOOGLE_CLIENT_ID = envFile.GOOGLE_CLIENT_ID
      process.env.GOOGLE_CLIENT_SECRET = envFile.GOOGLE_CLIENT_SECRET
      process.env.GOOGLE_REFRESH_TOKEN = envFile.GOOGLE_REFRESH_TOKEN
      if (envFile.GOOGLE_ACCESS_TOKEN)
        process.env.GOOGLE_ACCESS_TOKEN = envFile.GOOGLE_ACCESS_TOKEN

      await saveConfig({
        ...config,
        mode: 'local',
        clientId: envFile.GOOGLE_CLIENT_ID,
        clientSecret: envFile.GOOGLE_CLIENT_SECRET,
      })

      // Authenticate will auto-refresh the token
      const auth = await authenticate({ clientId: envFile.GOOGLE_CLIENT_ID, clientSecret: envFile.GOOGLE_CLIENT_SECRET }, false)

      // Save tokens for future use without env vars
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

    const mode = await select({
      message: 'Choose your setup mode:',
      options: [
        {
          value: 'cloud',
          label: 'Cloud (Recommended)',
          hint: 'Easy setup via cloud.gscdump.com - no API keys needed',
        },
        {
          value: 'local',
          label: 'Local',
          hint: 'Use your own Google OAuth credentials',
        },
      ],
    })

    if (isCancel(mode))
      process.exit(1)

    if (mode === 'cloud') {
      const cloudUrl = config.cloudUrl || DEFAULT_CLOUD_URL
      await saveConfig({ ...config, mode: 'cloud', cloudUrl })
      await authenticateCloud(cloudUrl, true)
    }
    else {
      await saveConfig({ ...config, mode: 'local' })
      const credentials = await getAuthCredentials(true)
      await authenticate(credentials, true)
    }

    console.log()
    logger.success('Setup complete! Run gscdump to get started.')
  },
})
