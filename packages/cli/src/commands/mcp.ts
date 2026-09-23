import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '../mcp/server'
import type { CliRuntime } from '../runtime'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defineCommand } from 'citty'
import { probeAuth } from '../auth'
import { mcpCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { createGscMcpServer } from '../mcp/server'
import { runWithCliRuntime, useCliRuntime } from '../runtime'
import { VERSION } from '../utils'

export const MCP_NO_AUTH_MESSAGE = [
  'gscdump has no Google authentication.',
  'Run `gscdump auth login` in a terminal, then call this tool again.',
  'For cloud mode, set GSCDUMP_API_KEY to a user API key from your gscdump.com settings.',
  'For local mode, set GSC_ACCESS_TOKEN, or GSC_CLIENT_ID, GSC_CLIENT_SECRET, and GSC_REFRESH_TOKEN.',
  'If you set environment variables, set them in the MCP server configuration and restart the MCP client.',
  'If the gscdump command is missing, run `npm install -g @gscdump/cli`.',
].join(' ')

// One retry per Google call. The CLI default retries a quota 403 after 5s,
// 15s and 45s. Those 65s exceed the 60s request timeout of most MCP clients,
// so the agent saw a timeout instead of the quota message.
const MCP_RETRIES = 1

/**
 * Start the MCP server on `transport`. Every request runs in `runtime`, so
 * tools read the config dir and profile of this invocation. Transport events
 * (stdin data) arrive outside the async context that started the server.
 */
export async function startMcpServer(transport: Transport, runtime: CliRuntime = useCliRuntime()): Promise<McpServer> {
  const server = createGscMcpServer({
    name: 'gscdump',
    version: VERSION,
    getContext: async () => {
      if (await probeAuth() === 'none')
        throw new Error(MCP_NO_AUTH_MESSAGE)
      const ctx = await createCommandContext({ needsAuth: true, fetchOptions: { retry: MCP_RETRIES } })
      return { authentication: ctx.authentication, auth: ctx.auth, client: ctx.client! }
    },
  })
  await server.connect(transport)
  const handle = transport.onmessage
  if (handle)
    transport.onmessage = (message, extra) => runWithCliRuntime(runtime, () => handle(message, extra))
  return server
}

export const mcpCommand = defineCommand({
  meta: mcpCommandMeta,
  async run() {
    await startMcpServer(new StdioServerTransport())
  },
})
