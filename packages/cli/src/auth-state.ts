import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gscdumpAvailableSiteSchema } from '@gscdump/contracts'
import { z } from 'zod'
import { HOSTED_KEY_REJECTED } from './error-handler'
import { useCliRuntime } from './runtime'

const apiRootSchema = z.url().transform(value => value.replace(/\/+$/, '')).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
}, 'Use HTTPS, or HTTP on loopback, for the API root')
const stateSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Local') }),
  z.object({ _tag: z.literal('Cloud'), apiRoot: apiRootSchema, apiKey: z.string().trim().regex(/^gsd_user_\S+$/) }),
])
export type Authentication = z.infer<typeof stateSchema>
export type CloudAuthentication = Extract<Authentication, { _tag: 'Cloud' }>

export function parseAuthMode(value: unknown): 'cloud' | 'local' | undefined {
  if (value === undefined || value === '')
    return undefined
  if (value === 'cloud' || value === 'local')
    return value
  throw new Error('Authentication mode must be cloud or local.')
}

export function parseAuthentication(value: unknown): Authentication {
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success)
    throw new Error('Invalid authentication. Use a gscdump user API key and a trusted API root.')
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

export async function resolveAuthentication(): Promise<Authentication> {
  const runtime = useCliRuntime()
  const env = runtime.environment
  const mode = runtime.authModeOverride ?? parseAuthMode(env.GSCDUMP_AUTH_MODE)
  if (mode === 'local')
    return { _tag: 'Local' }
  const body = await fs.readFile(path.join(runtime.configDir, 'authentication.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  const saved = body === null ? null : stateSchema.safeParse(JSON.parse(body))
  if (saved && !saved.success)
    throw new Error('Saved authentication is invalid. Run `gscdump auth login --mode cloud` or `--mode local`.')
  const state = saved?.success ? saved.data : null
  if (mode !== 'cloud' && state?._tag === 'Local')
    return state
  if (env.GSCDUMP_API_KEY) {
    const parsed = stateSchema.safeParse({
      _tag: 'Cloud',
      apiKey: env.GSCDUMP_API_KEY,
      apiRoot: env.GSCDUMP_API_ROOT ?? (state?._tag === 'Cloud' ? state.apiRoot : 'https://gscdump.com/api'),
    })
    if (!parsed.success)
      throw new Error('Invalid hosted authentication. Set GSCDUMP_API_KEY to a gscdump user API key.')
    return parsed.data
  }
  if (state?._tag === 'Cloud') {
    if (env.GSCDUMP_API_ROOT && env.GSCDUMP_API_ROOT.replace(/\/+$/, '') !== state.apiRoot)
      throw new Error('The API root changed. Supply GSCDUMP_API_KEY explicitly for the new API root.')
    return state
  }
  if (mode === 'cloud')
    throw new Error('Hosted credentials are missing. Run `gscdump auth login --mode cloud`.')
  return { _tag: 'Local' }
}

const accountSchema = z.object({
  user: z.object({ publicId: z.string(), email: z.string() }),
  sites: z.array(z.object({ siteId: z.string(), siteUrl: z.string() }).passthrough()),
})

export async function cloudRequest(state: CloudAuthentication, route: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${state.apiRoot}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey },
    signal: options.signal ?? AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  if (!response.ok) {
    const message = response.status === 401
      ? HOSTED_KEY_REJECTED
      : `Hosted request failed (${response.status}) for ${route.split('?')[0]}. Check \`gscdump auth status\`.`
    throw Object.assign(new Error(message), {
      statusCode: response.status,
      retryAfter: response.headers.get('retry-after'),
      response,
    })
  }
  return response.status === 204 ? undefined : response.json()
}

export async function getCloudAccount(state: CloudAuthentication): Promise<z.infer<typeof accountSchema>> {
  const result = accountSchema.safeParse(await cloudRequest(state, '/cli/me'))
  if (!result.success)
    throw new Error('The hosted API returned invalid account data.')
  return result.data
}

export type HostedSite = z.infer<typeof gscdumpAvailableSiteSchema>

/** The account's Sites with hosted sync status and progress. Reads `/cli/sites/available`. */
export async function getCloudSites(state: CloudAuthentication): Promise<HostedSite[]> {
  const result = gscdumpAvailableSiteSchema.array().safeParse(await cloudRequest(state, '/cli/sites/available'))
  if (!result.success)
    throw new Error('The hosted API returned invalid Site data.')
  return result.data
}

/** One line of hosted sync state, for example `syncing: 41 of 90 days (45%)`. Undefined for a Site gscdump.com does not sync. */
export function formatHostedSync(site: HostedSite): string | undefined {
  if (!site.registered)
    return undefined
  const status = site.syncStatus ?? 'pending'
  const progress = site.syncProgress && site.syncProgress.total > 0 && status !== 'synced'
    ? `: ${site.syncProgress.completed.toLocaleString('en-US')} of ${site.syncProgress.total.toLocaleString('en-US')} days (${Math.round(site.syncProgress.percent)}%)`
    : ''
  const range = status === 'synced' && site.oldestDateSynced && site.newestDateSynced ? `: ${site.oldestDateSynced} to ${site.newestDateSynced}` : ''
  return `${status}${progress}${range}`
}
