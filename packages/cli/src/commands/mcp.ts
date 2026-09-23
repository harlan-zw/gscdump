import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '../mcp/server'
import type { CliRuntime } from '../runtime'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defineCommand } from 'citty'
import { loadTokens, resolveBYOK, resolveServiceAccount } from '../auth'
import { resolveAuthentication } from '../auth-state'
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

/** True when some credential can reach Google without an interactive sign-in. */
async function hasAuthentication(): Promise<boolean> {
  if ((await resolveAuthentication())._tag === 'Cloud')
    return true
  // A stale pointer (missing or malformed key file) is ignorable here: it
  // must not block BYOK or saved tokens, which can still authenticate.
  if (await resolveServiceAccount().then(Boolean).catch(() => false))
    return true
  if (resolveBYOK())
    return true
  return (await loadTokens()) !== null
}

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
      if (!await hasAuthentication())
        throw new Error(MCP_NO_AUTH_MESSAGE)
      const ctx = await createCommandContext({ needsAuth: true })
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
