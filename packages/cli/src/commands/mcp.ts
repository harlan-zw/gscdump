import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { AuthError } from '../auth'
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
  'For local mode, set GSC_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS to a service-account key file, set GSC_ACCESS_TOKEN, or set GSC_CLIENT_ID, GSC_CLIENT_SECRET, and GSC_REFRESH_TOKEN.',
  'If you set environment variables, set them in the MCP server configuration and restart the MCP client.',
  'If the gscdump command is missing, run `npm install -g @gscdump/cli`.',
].join(' ')

// One retry per Google call. The CLI default retries a quota 403 after 5s,
// 15s and 45s. Those 65s exceed the 60s request timeout of most MCP clients,
// so the agent saw a timeout instead of the quota message.
const MCP_RETRIES = 1

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
 * The precise failure of a configured service-account key, shown only when no
 * other credential exists. A stale pointer (missing or malformed key file)
 * returns null: resolveAuth falls through to BYOK or saved tokens for it, so
 * the general advice stays right.
 */
async function serviceAccountMisconfiguration(): Promise<string | null> {
  return resolveServiceAccount()
    .then(() => null)
    .catch((error: unknown) => (error as { authError?: AuthError }).authError?.message ?? null)
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
      if (!await hasAuthentication()) {
        const misconfigured = await serviceAccountMisconfiguration()
        throw new Error(misconfigured ? `${misconfigured}. ${MCP_NO_AUTH_MESSAGE}` : MCP_NO_AUTH_MESSAGE)
      }
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
