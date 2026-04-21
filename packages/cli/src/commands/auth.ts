import { defineCommand } from 'citty'
import { clearTokens, loadTokens } from '../auth'
import { logger } from '../utils'

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current authentication status',
  },
  async run() {
    const tokens = await loadTokens()

    if (!tokens) {
      logger.warn('Not authenticated')
      logger.info('Run gscdump init to authenticate')
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
  },
})

const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Clear stored OAuth tokens',
  },
  async run() {
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
    logout: logoutCommand,
  },
})
