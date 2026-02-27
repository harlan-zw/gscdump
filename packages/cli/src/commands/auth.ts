import { defineCommand } from 'citty'
import { clearCloudTokens, clearTokens, loadCloudTokens, loadTokens } from '../auth'
import { loadConfig } from '../config'
import { logger } from '../utils'

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current authentication status',
  },
  async run() {
    const config = await loadConfig()

    console.log()
    console.log(`  Mode: ${config.mode ? `\x1B[36m${config.mode}\x1B[0m` : '\x1B[33mnot configured\x1B[0m'}`)

    if (!config.mode) {
      logger.info('Run gscdump init to configure')
      return
    }

    if (config.mode === 'cloud') {
      console.log(`  Cloud: \x1B[36m${config.cloudUrl}\x1B[0m`)
      const tokens = await loadCloudTokens()

      if (!tokens) {
        logger.warn('Not authenticated')
        logger.info('Run gscdump init --force to re-authenticate')
        return
      }

      const hasSession = !!tokens.sessionId
      const hasAccess = !!tokens.accessToken
      const hasRefresh = !!tokens.refreshToken
      const expiry = tokens.expiresAt ? new Date(tokens.expiresAt) : null
      const isExpired = expiry && expiry < new Date()

      logger.success('Authenticated')
      console.log()

      if (tokens.user?.email) {
        console.log(`  User:          \x1B[36m${tokens.user.email}\x1B[0m`)
      }
      if (tokens.user?.publicId) {
        console.log(`  User ID:       \x1B[90m${tokens.user.publicId}\x1B[0m`)
      }

      console.log(`  Session:       ${hasSession ? '\x1B[32mactive\x1B[0m' : '\x1B[31mmissing\x1B[0m'}`)
      console.log(`  Access token:  ${hasAccess ? '\x1B[32mpresent\x1B[0m' : '\x1B[31mmissing\x1B[0m'}`)
      console.log(`  Refresh token: ${hasRefresh ? '\x1B[32mpresent\x1B[0m' : '\x1B[31mmissing\x1B[0m'}`)
      if (expiry) {
        const status = isExpired ? '\x1B[33mexpired\x1B[0m' : '\x1B[32mvalid\x1B[0m'
        console.log(`  Expires:       ${expiry.toISOString()} (${status})`)
      }
    }
    else {
      // Local mode
      const tokens = await loadTokens()

      if (!tokens) {
        logger.warn('Not authenticated')
        logger.info('Run gscdump init --force to re-authenticate')
        return
      }

      const hasAccess = !!tokens.access_token
      const hasRefresh = !!tokens.refresh_token
      const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null
      const isExpired = expiry && expiry < new Date()

      logger.success('Authenticated')
      console.log()
      console.log(`  Access token:  ${hasAccess ? '\x1B[32mpresent\x1B[0m' : '\x1B[31mmissing\x1B[0m'}`)
      console.log(`  Refresh token: ${hasRefresh ? '\x1B[32mpresent\x1B[0m' : '\x1B[31mmissing\x1B[0m'}`)
      if (expiry) {
        const status = isExpired ? '\x1B[33mexpired\x1B[0m' : '\x1B[32mvalid\x1B[0m'
        console.log(`  Expires:       ${expiry.toISOString()} (${status})`)
      }
    }
  },
})

const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Clear stored OAuth tokens',
  },
  async run() {
    const config = await loadConfig()

    if (config.mode === 'cloud') {
      await clearCloudTokens()
    }
    else {
      await clearTokens()
    }
  },
})

export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Manage authentication',
  },
  subCommands: {
    status: statusCommand,
    logout: logoutCommand,
  },
})
