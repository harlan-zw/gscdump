import type { z } from 'zod'
import type { HandlerContext, listSitesInput } from '../types'
import { ofetch } from 'ofetch'

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
  'https://www.googleapis.com/auth/siteverification',
]
const FETCH_TIMEOUT_MS = 5000
const TIME_SKEW_WARN_MS = 5 * 60_000

export interface DiagnosticsCheck {
  name: string
  status: 'pass' | 'warn' | 'fail' | 'info'
  detail?: string
}

export interface DiagnosticsResult {
  ok: boolean
  checks: DiagnosticsCheck[]
}

export async function diagnostics(
  _input: z.infer<typeof listSitesInput>,
  ctx: HandlerContext,
): Promise<DiagnosticsResult> {
  const checks: DiagnosticsCheck[] = []

  const token = await resolveAccessToken(ctx.auth)
  if (!token) {
    checks.push({ name: 'auth', status: 'fail', detail: 'no usable access token (refresh failed or no credentials)' })
    return { ok: false, checks }
  }

  const [tokenInfo, timeCheck, gscReachable, indexingReachable, sites] = await Promise.all([
    ofetch<{ scope?: string, email?: string, expires_in?: number }>(
      'https://oauth2.googleapis.com/tokeninfo',
      { query: { access_token: token } },
    ).catch((e: Error) => ({ error: e.message } as const)),
    probeTimeSkew(),
    probeReachable('https://searchconsole.googleapis.com/$discovery/rest?version=v1'),
    probeReachable('https://indexing.googleapis.com/$discovery/rest?version=v3'),
    ctx.client.sites().catch((e: Error) => e),
  ])

  if ('error' in tokenInfo) {
    checks.push({ name: 'auth', status: 'fail', detail: `tokeninfo failed: ${tokenInfo.error}` })
  }
  else {
    checks.push({ name: 'auth', status: 'pass', detail: tokenInfo.email ?? 'token valid' })
    const scopes = tokenInfo.scope ? tokenInfo.scope.split(/\s+/) : []
    const missing = REQUIRED_SCOPES.filter(s => !scopes.includes(s))
    checks.push(missing.length > 0
      ? { name: 'auth.scopes', status: 'warn', detail: `missing: ${missing.join(', ')}` }
      : { name: 'auth.scopes', status: 'pass', detail: `${scopes.length} granted` })
  }

  checks.push(timeCheck)
  checks.push({
    name: 'gsc.api',
    status: gscReachable ? 'pass' : 'warn',
    detail: gscReachable ? 'reachable' : 'searchconsole.googleapis.com unreachable',
  })
  checks.push({
    name: 'indexing.api',
    status: indexingReachable ? 'pass' : 'warn',
    detail: indexingReachable ? 'reachable' : 'indexing.googleapis.com unreachable',
  })

  if (sites instanceof Error) {
    checks.push({ name: 'gsc.sites', status: 'fail', detail: `sites() failed: ${sites.message}` })
  }
  else {
    const verified = sites.filter(s => s.permissionLevel !== 'siteUnverifiedUser').length
    checks.push({
      name: 'gsc.sites',
      status: 'pass',
      detail: `${sites.length} site(s) accessible (${verified} verified)`,
    })
  }

  return { ok: !checks.some(c => c.status === 'fail'), checks }
}

async function resolveAccessToken(auth: HandlerContext['auth']): Promise<string | null> {
  if (typeof auth === 'string')
    return auth
  if (auth && typeof auth === 'object' && 'getAccessToken' in auth) {
    const result = await (auth as { getAccessToken: () => Promise<{ token?: string | null }> })
      .getAccessToken()
      .catch(() => null)
    return result?.token ?? null
  }
  return null
}

async function probeTimeSkew(): Promise<DiagnosticsCheck> {
  const dateHeader = await ofetch.raw('https://oauth2.googleapis.com/tokeninfo', {
    method: 'GET',
    timeout: FETCH_TIMEOUT_MS,
  })
    .then(r => r.headers.get('date'))
    .catch((e: { response?: { headers?: { get: (k: string) => string | null } } }) => e?.response?.headers?.get('date') ?? null)
  if (!dateHeader)
    return { name: 'time', status: 'warn', detail: 'no Date header' }
  const remoteMs = Date.parse(dateHeader)
  if (!Number.isFinite(remoteMs))
    return { name: 'time', status: 'warn', detail: `unparseable Date header: ${dateHeader}` }
  const skewMs = Date.now() - remoteMs
  const human = `${skewMs >= 0 ? '+' : ''}${(skewMs / 1000).toFixed(1)}s`
  if (Math.abs(skewMs) > TIME_SKEW_WARN_MS)
    return { name: 'time', status: 'warn', detail: `local clock ${human} off Google` }
  return { name: 'time', status: 'pass', detail: `in sync (${human})` }
}

async function probeReachable(url: string): Promise<boolean> {
  return ofetch.raw(url, { method: 'GET', timeout: FETCH_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false)
}
