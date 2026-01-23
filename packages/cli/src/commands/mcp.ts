import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defineCommand } from 'citty'
import { getAuth, loadCloudTokens, loadTokens } from '../auth'
import { loadConfig } from '../config'
import { createGscMcpServer } from '../mcp/server'
import { VERSION } from '../utils'

async function checkAuth(): Promise<{ ok: boolean, error?: string }> {
  // Check for direct token env vars first - bypasses all config
  // Need client ID/secret plus either access token or refresh token
  if ((process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN) && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { ok: true }
  }

  const config = await loadConfig()

  if (!config.mode) {
    return {
      ok: false,
      error: `GSCDump not configured.

Run this command to set up authentication:

  npx @gscdump/cli init

Or provide env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ACCESS_TOKEN

Then restart your MCP client.`,
    }
  }

  if (config.mode === 'cloud') {
    const tokens = await loadCloudTokens()
    if (!tokens) {
      return {
        ok: false,
        error: `Cloud authentication expired or missing.

Run this command to re-authenticate:

  npx @gscdump/cli init

Then restart your MCP client.`,
      }
    }
  }
  else {
    // Local mode - check for OAuth tokens
    const tokens = await loadTokens()
    if (!tokens) {
      return {
        ok: false,
        error: `Local authentication missing.

Run this command to authenticate:

  npx @gscdump/cli auth

Then restart your MCP client.`,
      }
    }
  }

  return { ok: true }
}

export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description: 'Start MCP server for AI assistants',
  },
  async run() {
    // Check auth before starting - can't prompt interactively in MCP mode
    const authCheck = await checkAuth()
    if (!authCheck.ok) {
      process.stderr.write(`\n${authCheck.error}\n\n`)
      process.exit(1)
    }

    const server = createGscMcpServer({
      name: 'gscdump',
      version: VERSION,
      getAuth: () => getAuth({ interactive: false }),
    })

    const transport = new StdioServerTransport()
    await server.connect(transport)
  },
})
