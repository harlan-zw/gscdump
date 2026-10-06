import type { CredentialSource } from './shared/protocol'
import { z } from 'zod'

const DEFAULT_API_ROOT = 'https://gscdump.com/api'

/** A Hosted credential. The devframe holds it on the node side; it never reaches the panel. */
export type GscdumpCredential
  = | { _tag: 'ApiKey', apiKey: string, apiRoot: string, source: CredentialSource }
    | { _tag: 'CliSession', sessionId: string, apiRoot: string, source: 'cli-session' }

/** The `authentication.json` that `gscdump auth login --mode hosted` saves. */
const cliAuthenticationSchema = z.union([
  z.object({ _tag: z.literal('Hosted'), apiRoot: z.string().url(), sessionId: z.string().min(1) }),
  z.object({ _tag: z.literal('Hosted'), apiRoot: z.string().url(), apiKey: z.string().min(1) }),
  z.object({ _tag: z.literal('Local') }),
])

export interface CredentialInput {
  apiKey?: string
  apiRoot?: string
  env: Record<string, string | undefined>
  /** Reads the CLI's saved authentication. Resolves `null` when the CLI never logged in. */
  readCliAuthentication: () => Promise<unknown>
}

function trimRoot(root: string): string {
  return root.replace(/\/+$/, '')
}

/**
 * Pick the Hosted credential: the `apiKey` option, then `GSCDUMP_API_KEY`, then
 * the CLI's saved Hosted login. A saved Local login holds no Hosted credential.
 */
export async function resolveCredential(input: CredentialInput): Promise<GscdumpCredential | null> {
  const apiRoot = trimRoot(input.apiRoot ?? input.env.GSCDUMP_API_ROOT ?? DEFAULT_API_ROOT)
  if (input.apiKey)
    return { _tag: 'ApiKey', apiKey: input.apiKey, apiRoot, source: 'option' }
  if (input.env.GSCDUMP_API_KEY)
    return { _tag: 'ApiKey', apiKey: input.env.GSCDUMP_API_KEY, apiRoot, source: 'env' }
  const saved = await input.readCliAuthentication()
  if (saved == null)
    return null
  const parsed = cliAuthenticationSchema.safeParse(saved)
  if (!parsed.success || parsed.data._tag === 'Local')
    return null
  const root = trimRoot(parsed.data.apiRoot)
  return 'sessionId' in parsed.data
    ? { _tag: 'CliSession', sessionId: parsed.data.sessionId, apiRoot: root, source: 'cli-session' }
    : { _tag: 'ApiKey', apiKey: parsed.data.apiKey, apiRoot: root, source: 'cli-session' }
}

/** The Bearer value for the public v1 API. */
export function bearerOf(credential: GscdumpCredential): string {
  return credential._tag === 'CliSession' ? credential.sessionId : credential.apiKey
}

/** The headers `/api/cli/me` reads. It predates v1 and does not read a Bearer credential. */
export function cliHeadersOf(credential: GscdumpCredential): Record<string, string> {
  return credential._tag === 'CliSession'
    ? { 'x-cli-session': credential.sessionId }
    : { 'x-api-key': credential.apiKey }
}

/** The gscdump.com origin that serves the dashboard for this API root. */
export function dashboardOrigin(apiRoot: string): string {
  return URL.parse(apiRoot)?.origin ?? 'https://gscdump.com'
}
