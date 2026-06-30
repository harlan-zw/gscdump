import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defineCommand } from 'citty'
import { loadTokens, resolveAuth, resolveBYOK, resolveServiceAccount } from '../auth'
import { loadConfig } from '../config'
import { createGscMcpServer } from '../mcp/server'
import { VERSION } from '../utils'

async function checkAuth(): Promise<{ ok: boolean, error?: string }> {
  // Service-account auth is sufficient when configured.
  if (await resolveServiceAccount().then(Boolean).catch(() => false))
    return { ok: true }

  // BYOK (GSC_* or GOOGLE_* env vars) is sufficient on its own.
  if (resolveBYOK())
    return { ok: true }

  const config = await loadConfig()
  if (!config.clientId && !config.clientSecret) {
    return {
      ok: false,
      error: `GSCDump not configured.

Run this command to set up authentication:

  npx @gscdump/cli init

Or set BYOK env vars: GSC_ACCESS_TOKEN, or GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN
(GOOGLE_* aliases also accepted).

Then restart your MCP client.`,
    }
  }

  const tokens = await loadTokens()
  if (!tokens) {
    return {
      ok: false,
      error: `Authentication missing.

Run this command to authenticate:

  npx @gscdump/cli auth login

Then restart your MCP client.`,
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
    const authCheck = await checkAuth()
    if (!authCheck.ok) {
      process.stderr.write(`\n${authCheck.error}\n\n`)
      process.exit(1)
    }

    const server = createGscMcpServer({
      name: 'gscdump',
      version: VERSION,
      getAuth: () => resolveAuth({ interactive: false }),
    })

    const transport = new StdioServerTransport()
    await server.connect(transport)
  },
})
