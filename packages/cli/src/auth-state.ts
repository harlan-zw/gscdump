import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { HOSTED_KEY_REJECTED } from './error-handler'
import { useCliRuntime } from './runtime'

export const HOSTED_SESSION_REJECTED = 'gscdump.com rejected the CLI session. Run `gscdump auth login --mode hosted` again.'

/** A command that calls Google ran in Hosted mode. */
export const LOCAL_MODE_REQUIRED = [
  'This command calls Google, so it needs Local mode.',
  'Hosted mode reads your gscdump.com record and never calls Google.',
  'If you want Local mode, run `gscdump auth login --mode local`.',
].join('\n')

/** Hosted mode is selected, but no CLI session or API key exists. */
export const HOSTED_NOT_SET_UP = 'Hosted credentials are missing. Run `gscdump auth login --mode hosted`, or set GSCDUMP_API_KEY.'

const SAVED_STATE_INVALID = 'The saved access mode is invalid. Run `gscdump auth login --mode local` or `gscdump auth login --mode hosted`.'

const apiRootSchema = z.url().transform(value => value.replace(/\/+$/, '')).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
}, 'Use HTTPS, or HTTP on loopback, for the API root')
const stateSchema = z.union([
  z.object({ _tag: z.literal('Local') }),
  z.object({ _tag: z.literal('Hosted'), apiRoot: apiRootSchema, apiKey: z.string().trim().regex(/^gsd_user_\S+$/) }),
  z.object({ _tag: z.literal('Hosted'), apiRoot: apiRootSchema, sessionId: z.string().regex(/^[a-f0-9]{64}$/) }),
])
export type Authentication = z.infer<typeof stateSchema>
export type HostedAuthentication = Extract<Authentication, { _tag: 'Hosted' }>

/** The two access modes. Local calls Google with your own credentials. Hosted reads your gscdump.com record. */
export type AccessMode = 'local' | 'hosted'

export function parseAuthMode(value: unknown): AccessMode | undefined {
  if (value === undefined || value === '')
    return undefined
  if (value === 'local' || value === 'hosted')
    return value
  throw new Error('Access mode must be local or hosted.')
}

export type AccessModeSource = 'flag' | 'env' | 'saved' | 'api-key' | 'default'

/**
 * Pick the access mode. Pure. Order: the `--mode` flag, then
 * `GSCDUMP_AUTH_MODE`, then the saved mode, then `GSCDUMP_API_KEY` (Hosted).
 * Local applies when nothing is set.
 */
export function resolveAccessMode(input: { flag?: AccessMode, env?: string, saved?: AccessMode, apiKey?: string }): { mode: AccessMode, source: AccessModeSource } {
  if (input.flag)
    return { mode: input.flag, source: 'flag' }
  const env = parseAuthMode(input.env)
  if (env)
    return { mode: env, source: 'env' }
  if (input.saved)
    return { mode: input.saved, source: 'saved' }
  if (input.apiKey)
    return { mode: 'hosted', source: 'api-key' }
  return { mode: 'local', source: 'default' }
}

export function parseAuthentication(value: unknown): Authentication {
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success)
    throw new Error('Invalid Hosted credentials. Use a CLI session or a gscdump user API key with a trusted API root.')
  return parsed.data
}

export async function saveAuthentication(state: Authentication): Promise<void> {
  const parsed = parseAuthentication(state)
  const configDir = useCliRuntime().configDir
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 })
  const target = path.join(configDir, 'authentication.json')
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(parsed, null, 2), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, target)
  }
  finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function clearAuthentication(): Promise<void> {
  await fs.rm(path.join(useCliRuntime().configDir, 'authentication.json'), { force: true })
}

export async function revokeHostedSession(state: HostedAuthentication): Promise<void> {
  if (!('sessionId' in state))
    return
  await hostedRequest(state, '/cli/auth/logout', { method: 'POST' })
}

async function readSavedAuthentication(configDir: string): Promise<Authentication | null> {
  const body = await fs.readFile(path.join(configDir, 'authentication.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (body === null)
    return null
  const saved = stateSchema.safeParse(JSON.parse(body))
  if (!saved.success)
    throw new Error(SAVED_STATE_INVALID)
  return saved.data
}

/** The credentials of the selected access mode. Hosted without credentials throws {@link HOSTED_NOT_SET_UP}. */
export async function resolveAuthentication(): Promise<Authentication> {
  const runtime = useCliRuntime()
  const env = runtime.environment
  const flag = runtime.authModeOverride
  const envMode = parseAuthMode(env.GSCDUMP_AUTH_MODE)
  if ((flag ?? envMode) === 'local')
    return { _tag: 'Local' }
  const state = await readSavedAuthentication(runtime.configDir)
  const { mode } = resolveAccessMode({ flag, env: envMode, saved: state ? (state._tag === 'Hosted' ? 'hosted' : 'local') : undefined, apiKey: env.GSCDUMP_API_KEY })
  if (mode === 'local')
    return { _tag: 'Local' }
  if (env.GSCDUMP_API_KEY) {
    const parsed = stateSchema.safeParse({
      _tag: 'Hosted',
      apiKey: env.GSCDUMP_API_KEY,
      apiRoot: env.GSCDUMP_API_ROOT ?? (state?._tag === 'Hosted' ? state.apiRoot : 'https://gscdump.com/api'),
    })
    if (!parsed.success)
      throw new Error('GSCDUMP_API_KEY is invalid. Set it to a gscdump user API key.')
    return parsed.data
  }
  if (state?._tag === 'Hosted') {
    if (env.GSCDUMP_API_ROOT && env.GSCDUMP_API_ROOT.replace(/\/+$/, '') !== state.apiRoot)
      throw new Error('The API root changed. Run `gscdump auth login --mode hosted` for the new API root.')
    return state
  }
  throw new Error(HOSTED_NOT_SET_UP)
}

const hostedSiteSchema = z.object({
  siteId: z.string(),
  siteUrl: z.string(),
  syncStatus: z.string().nullable().optional(),
  syncProgress: z.object({ completed: z.number(), total: z.number(), percent: z.number() }).passthrough().nullable().optional(),
  lastSyncAt: z.number().nullable().optional(),
  newestDateSynced: z.string().nullable().optional(),
  oldestDateSynced: z.string().nullable().optional(),
}).passthrough()
const accountSchema = z.object({
  user: z.object({ publicId: z.string(), email: z.string() }),
  sites: z.array(hostedSiteSchema),
})

/** One Site in the hosted record, with its hosted sync state. */
export type HostedSite = z.infer<typeof hostedSiteSchema>

export async function hostedRequest(state: HostedAuthentication, route: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${state.apiRoot}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...('sessionId' in state ? { 'x-cli-session': state.sessionId } : { 'x-api-key': state.apiKey }) },
    signal: options.signal ?? AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  if (!response.ok) {
    const message = response.status === 401
      ? 'sessionId' in state ? HOSTED_SESSION_REJECTED : HOSTED_KEY_REJECTED
      : `Hosted request failed (${response.status}) for ${route.split('?')[0]}. Check \`gscdump auth status\`.`
    throw Object.assign(new Error(message), {
      statusCode: response.status,
      retryAfter: response.headers.get('retry-after'),
      response,
    })
  }
  return response.status === 204 ? undefined : response.json()
}

export function hostedCredential(state: HostedAuthentication): string {
  return 'sessionId' in state ? state.sessionId : state.apiKey
}

export async function getHostedAccount(state: HostedAuthentication): Promise<z.infer<typeof accountSchema>> {
  const result = accountSchema.safeParse(await hostedRequest(state, '/cli/me'))
  if (!result.success)
    throw new Error('gscdump.com returned invalid account data.')
  return result.data
}

/** One line of hosted sync state, for example `syncing: 41 of 90 days (45%)`. */
export function formatHostedSync(site: HostedSite): string {
  const status = site.syncStatus ?? 'pending'
  const progress = site.syncProgress && site.syncProgress.total > 0 && status !== 'synced'
    ? `: ${site.syncProgress.completed.toLocaleString('en-US')} of ${site.syncProgress.total.toLocaleString('en-US')} days (${Math.round(site.syncProgress.percent)}%)`
    : ''
  const range = status === 'synced' && site.oldestDateSynced && site.newestDateSynced ? `: ${site.oldestDateSynced} to ${site.newestDateSynced}` : ''
  return `${status}${progress}${range}`
}
