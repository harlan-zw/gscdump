import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@gscdump/engine/filesystem'
import { z } from 'zod'
import { HOSTED_KEY_REJECTED_MESSAGE, HOSTED_SESSION_EXPIRED, HOSTED_SESSION_REJECTED_MESSAGE, isSessionExpiredBody } from './hosted-session'
import { useCliRuntime } from './runtime'
import { stopError } from './stop'

export const HOSTED_SESSION_REJECTED = HOSTED_SESSION_REJECTED_MESSAGE
/** A hosted 401: the gscdump.com API key failed, not a Google credential. */
export const HOSTED_KEY_REJECTED = HOSTED_KEY_REJECTED_MESSAGE

/** A command that calls Google ran in Hosted mode. */
export const LOCAL_MODE_REQUIRED = [
  'This command calls Google, so it needs Local mode.',
  'This command needs your own Google credentials. Hosted inspections use the platform separately.',
  'If you want Local mode, run `gscdump auth login --mode local`.',
].join('\n')

/** Stop a command that calls Google in Hosted mode. `detail` names a narrower cause. */
export function localModeRequired(detail?: string): Error {
  return stopError({
    code: 'LOCAL_MODE_REQUIRED',
    message: detail ? `${detail}\n${LOCAL_MODE_REQUIRED}` : LOCAL_MODE_REQUIRED,
    nextCommand: 'gscdump auth login --mode local',
  })
}

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
  const target = path.join(useCliRuntime().configDir, 'authentication.json')
  await writeFileAtomic(target, JSON.stringify(parsed, null, 2), { dirMode: 0o700, mode: 0o600, flag: 'wx' })
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
  throw stopError({ code: 'HOSTED_CREDENTIALS_MISSING', message: HOSTED_NOT_SET_UP, nextCommand: 'gscdump auth login --mode hosted' })
}

const hostedSiteSchema = z.object({
  siteId: z.string(),
  siteUrl: z.string(),
  syncStatus: z.string().nullable().optional(),
  syncProgress: z.object({ completed: z.number(), total: z.number(), percent: z.number() }).passthrough().nullable().optional(),
  hold: z.string().nullable().optional(),
  holdMessage: z.string().nullable().optional(),
  lastSyncAt: z.number().nullable().optional(),
  newestDateSynced: z.string().nullable().optional(),
  oldestDateSynced: z.string().nullable().optional(),
}).passthrough()
/** A partner's display name, for example `Request Indexing`. It reaches the terminal, so control characters fail the parse. */
const partnerNameSchema = z.string().trim().min(1).max(80).regex(/^\P{Cc}+$/u)
const keyIssuerSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('gscdump') }),
  z.object({ _tag: z.literal('partner'), name: partnerNameSchema }),
])
/** Who issued the Hosted credential, as `/cli/me` reports it. */
export type KeyIssuer = z.infer<typeof keyIssuerSchema>

const hostedAccountStatusSchema = z.object({
  hostedAccess: z.boolean(),
  needsReauth: z.boolean(),
  searchConsoleScopeGranted: z.boolean().nullable().optional().default(null),
}).passthrough()

const accountSchema = z.object({
  user: z.object({ publicId: z.string(), email: z.string() }),
  sites: z.array(hostedSiteSchema),
  hostedAccess: z.boolean().optional().catch(undefined),
  accountStatus: hostedAccountStatusSchema.optional().catch(undefined),
  // An older gscdump.com omits `issuer`. An issuer this CLI cannot read, such
  // as a later issuer kind, is unknown in the same way. Neither one fails the
  // account: the stops then use wording that names no product.
  issuer: keyIssuerSchema.optional().catch(undefined),
})

export type HostedAccount = z.infer<typeof accountSchema>

const hostedEstimateSchema = z.object({
  status: z.enum(['fits', 'unmeasured', 'held', 'refused', 'exempt']),
  lines: z.array(z.string()),
  inspectionDefault: z.boolean(),
}).passthrough()

const hostedAvailablePropertySchema = z.object({
  propertyUrl: z.string(),
  propertyType: z.enum(['domain', 'url-prefix']),
  permissionLevel: z.string(),
  canConnect: z.boolean(),
  hostScope: z.enum(['exact', 'domain']),
  host: z.string(),
  connected: z.boolean(),
  connectedSites: z.array(z.object({
    siteId: z.string().nullable(),
    siteUrl: z.string(),
  }).passthrough()),
  estimate: hostedEstimateSchema.nullable().optional().default(null),
  estimateNote: z.string().nullable().optional(),
}).passthrough()

const hostedAvailablePropertiesSchema = z.object({
  properties: z.array(hostedAvailablePropertySchema),
  sites: z.object({
    used: z.number(),
    allowance: z.number(),
    remaining: z.number(),
  }).passthrough(),
  note: z.string().nullable().optional(),
}).passthrough()

export type HostedAvailableProperty = z.infer<typeof hostedAvailablePropertySchema>
export type HostedAvailableProperties = z.infer<typeof hostedAvailablePropertiesSchema>

const hostedSiteConnectionSchema = z.object({
  status: z.enum(['connected', 'already_connected']),
  message: z.string(),
  site: z.object({
    siteId: z.string().nullable(),
    siteUrl: z.string(),
    propertyUrl: z.string(),
    syncStatus: z.string().nullable().optional().default(null),
  }).passthrough(),
  estimate: hostedEstimateSchema.nullable().optional(),
  inspectionEnabled: z.boolean().optional(),
}).passthrough()

export type HostedSiteConnection = z.infer<typeof hostedSiteConnectionSchema>

/** One Site in the hosted record, with its hosted sync state. */
export type HostedSite = z.infer<typeof hostedSiteSchema>

function extractHostedErrorDetails(body: unknown): { message: string | null, reason: string | null } {
  if (!body || typeof body !== 'object')
    return { message: null, reason: null }
  const record = body as Record<string, unknown>
  const nested = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : null
  const errorObj = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null
  const message = (typeof nested?.message === 'string' && nested.message.trim())
    || (typeof errorObj?.message === 'string' && errorObj.message.trim())
    || (typeof record.message === 'string' && record.message.trim())
    || null
  const detailsObj = (nested?.details && typeof nested.details === 'object' ? nested.details as Record<string, unknown> : null)
    ?? (errorObj?.details && typeof errorObj.details === 'object' ? errorObj.details as Record<string, unknown> : null)
    ?? (record.details && typeof record.details === 'object' ? record.details as Record<string, unknown> : null)
  const reason = typeof detailsObj?.reason === 'string' && detailsObj.reason.trim() ? detailsObj.reason : null
  return { message, reason }
}

export async function hostedRequest(state: HostedAuthentication, route: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${state.apiRoot}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...('sessionId' in state ? { 'x-cli-session': state.sessionId } : { 'x-api-key': state.apiKey }) },
    signal: options.signal ?? AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  if (!response.ok) {
    const details = { statusCode: response.status, retryAfter: response.headers.get('retry-after'), response }
    if (response.status === 401) {
      const session = 'sessionId' in state
      // A 401 body that is not JSON carries no reason. It stays an ordinary rejection.
      const expired = session && isSessionExpiredBody(await response.json().catch(() => null))
      throw Object.assign(stopError(expired
        ? HOSTED_SESSION_EXPIRED
        : {
            code: 'HOSTED_CREDENTIALS_REJECTED',
            message: session ? HOSTED_SESSION_REJECTED : HOSTED_KEY_REJECTED,
            // A rejected API key needs a new key. Only its issuer can make one.
            nextCommand: session ? 'gscdump auth login --mode hosted' : null,
          }), details)
    }
    const parsed = response.status < 500
      ? extractHostedErrorDetails(await response.json().catch(() => null))
      : { message: null, reason: null }
    const suffix = parsed.message ? ` ${parsed.message}` : ' Check `gscdump auth status`.'
    const error = Object.assign(new Error(`Hosted request failed (${response.status}) for ${route.split('?')[0]}.${suffix}`), {
      hostedRequestError: true as const,
      ...details,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    })
    error.name = 'HostedRequestError'
    throw error
  }
  return response.status === 204 ? undefined : response.json()
}

export function hostedCredential(state: HostedAuthentication): string {
  return 'sessionId' in state ? state.sessionId : state.apiKey
}

/**
 * Where the holder of a Hosted credential manages Sites. A CLI session comes
 * from the gscdump.com browser login. An API key comes from gscdump.com or
 * from a partner app, and `/cli/me` names its issuer. An older gscdump.com does
 * not, so the CLI then names no product: it never sends a partner's user to
 * gscdump.com.
 */
export type SiteManager
  = | { _tag: 'gscdump' }
    | { _tag: 'partner', name: string }
    | { _tag: 'key_issuer' }

export function siteManagerOf(state: HostedAuthentication, issuer: KeyIssuer | undefined): SiteManager {
  if ('sessionId' in state)
    return { _tag: 'gscdump' }
  return issuer ?? { _tag: 'key_issuer' }
}

/** Where the holder connects a Site, for example `at https://gscdump.com/…`. */
function connectSitePlace(manager: SiteManager): string {
  switch (manager._tag) {
    case 'gscdump': return 'at https://gscdump.com/app/onboarding?step=connect-sites'
    case 'partner': return `in ${manager.name}`
    case 'key_issuer': return 'in the app that issued this API key'
  }
}

/** The step that adds a Site to the hosted record, for example `Connect a Site at …`. */
export function connectSiteStep(manager: SiteManager): string {
  return `Connect a Site ${connectSitePlace(manager)}.`
}

/**
 * The next step for a hosted record with no Sites, after `auth login` and in
 * `auth status`. The gscdump.com app opens only after Hosted access is
 * activated, so the connect link can open the activation page first.
 */
export function noSitesNextStep(manager: SiteManager): string {
  const next = `Next: connect a Site ${connectSitePlace(manager)}.`
  return manager._tag === 'gscdump' ? `${next} If Hosted access is not active, gscdump.com asks you to activate it first.` : next
}

/** Where a Site's settings live, for example `in the Site settings on gscdump.com`. */
export function siteSettingsPlace(manager: SiteManager): string {
  switch (manager._tag) {
    case 'gscdump': return 'in the Site settings on gscdump.com'
    case 'partner': return `in the Site settings of ${manager.name}`
    case 'key_issuer': return 'in the Site settings of the app that issued this API key'
  }
}

export async function getHostedAccount(state: HostedAuthentication): Promise<HostedAccount> {
  const result = accountSchema.safeParse(await hostedRequest(state, '/cli/me'))
  if (!result.success)
    throw new Error('gscdump.com returned invalid account data.')
  return result.data
}

export async function listHostedAvailableProperties(state: HostedAuthentication): Promise<HostedAvailableProperties> {
  const result = hostedAvailablePropertiesSchema.safeParse(await hostedRequest(state, '/cli/sites/available'))
  if (!result.success)
    throw new Error('gscdump.com returned invalid property data.')
  return result.data
}

export async function connectHostedSite(
  state: HostedAuthentication,
  input: { propertyUrl: string, host?: string, inspectionEnabled?: boolean },
): Promise<HostedSiteConnection> {
  const result = hostedSiteConnectionSchema.safeParse(await hostedRequest(state, '/cli/sites/connect', {
    method: 'POST',
    body: JSON.stringify(input),
  }))
  if (!result.success)
    throw new Error('gscdump.com returned invalid Site connection data.')
  return result.data
}

const HOSTED_GOOGLE_RECONNECT_URL = 'https://gscdump.com/auth/google?reauth=1&redirect=%2Fapp%2Fonboarding%3Fstep%3Dconnect-sites%26agent%3Dskip'

function reconnectGooglePlace(manager: SiteManager): string {
  switch (manager._tag) {
    case 'gscdump': return `at ${HOSTED_GOOGLE_RECONNECT_URL}`
    case 'partner': return `in ${manager.name}`
    case 'key_issuer': return 'in the app that issued this API key'
  }
}

/** Actionable account-level warnings returned by `/cli/me`, empty when healthy or unsupported by an older host. */
export function hostedAccountWarnings(account: HostedAccount, manager: SiteManager): string[] {
  const warnings: string[] = []
  const hostedAccess = account.hostedAccess ?? account.accountStatus?.hostedAccess
  if (hostedAccess === false && manager._tag === 'gscdump')
    warnings.push('Hosted access is not active. Activate Hosted at https://gscdump.com/app/activate.')
  const reconnect = reconnectGooglePlace(manager)
  if (account.accountStatus?.needsReauth)
    warnings.push(`Google access expired. Reconnect Google ${reconnect}.`)
  else if (account.accountStatus?.searchConsoleScopeGranted === false)
    warnings.push(`Search Console read access is missing. Reconnect Google ${reconnect} and keep the Search Console box ticked.`)
  return warnings
}

/** One line of hosted sync state, for example `syncing: 41 of 90 days (45%)`. */
export function formatHostedSync(site: HostedSite): string {
  if (site.hold === 'size_pending')
    return 'measuring (pending size check)'
  if (site.hold)
    return site.holdMessage ? `held (${site.hold}): ${site.holdMessage}` : `held (${site.hold})`
  const status = site.syncStatus ?? 'pending'
  const progress = site.syncProgress && site.syncProgress.total > 0 && status !== 'synced'
    ? `: ${site.syncProgress.completed.toLocaleString('en-US')} of ${site.syncProgress.total.toLocaleString('en-US')} days (${Math.round(site.syncProgress.percent)}%)`
    : ''
  const range = status === 'synced' && site.oldestDateSynced && site.newestDateSynced ? `: ${site.oldestDateSynced} to ${site.newestDateSynced}` : ''
  return `${status}${progress}${range}`
}
