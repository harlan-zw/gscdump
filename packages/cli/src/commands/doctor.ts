import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump'
import { ofetch } from 'ofetch'
import { loadTokens, resolveAuth, resolveBYOK } from '../auth'
import { missingRequiredScopes } from '../auth-scopes'
import { loadConfig } from '../config'
import { createCommandContext } from '../context'
import { parseEnvFile } from '../env-file'
import { resolveCliEnvironment } from '../environment'
import { createLocalStore } from '../local-store'
import { applyOutputMode, displayPath, logger, OUTPUT_ARGS } from '../utils'

interface Check {
  name: string
  status: 'pass' | 'warn' | 'fail' | 'info'
  detail?: string
}

const FETCH_TIMEOUT_MS = 5000
const TIME_SKEW_WARN_MS = 5 * 60_000
const WATERMARK_STALE_DAYS_WARN = 7
const RELEVANT_ENV_KEYS = [
  'GSC_ACCESS_TOKEN',
  'GSC_CLIENT_ID',
  'GSC_CLIENT_SECRET',
  'GSC_REFRESH_TOKEN',
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GSC_SERVICE_ACCOUNT_JSON',
]

/** Redact a credential value, keeping the last 6 chars for visual identification. */
function redact(v: string | undefined): string {
  if (!v)
    return '<missing>'
  if (v.length <= 6)
    return '***'
  return `***${v.slice(-6)}`
}

// Inventory only — does NOT validate the credentials. The `auth` check below
// is the source of truth for whether the env-provided creds actually work.
async function checkEnv(): Promise<{ checks: Check[], envKeys: Set<string> }> {
  const envPath = path.join(process.cwd(), '.env')
  const parsed = parseEnvFile(envPath)
  if (!parsed)
    return { checks: [{ name: 'env', status: 'info', detail: 'no .env (using shell env / saved tokens)' }], envKeys: new Set() }

  const relevant = RELEVANT_ENV_KEYS.filter(k => parsed[k] !== undefined)
  const envKeys = new Set(relevant)
  if (relevant.length === 0)
    return { checks: [{ name: 'env', status: 'info', detail: `${displayPath(envPath)} found, no auth vars` }], envKeys }
  // Show CLIENT_ID in full (it's not secret), redact the others.
  const inventory = relevant.map((k) => {
    const v = parsed[k]
    if (k.endsWith('CLIENT_ID'))
      return `${k}=${v}`
    return `${k}=${redact(v)}`
  })
  return { checks: [{ name: 'env', status: 'info', detail: `${displayPath(envPath)} → ${inventory.join(', ')} (not validated — see auth)` }], envKeys }
}

function describeAuthSource(envKeys: Set<string>, byok: ReturnType<typeof resolveBYOK>): string {
  if (!byok)
    return 'saved tokens'
  // Pinpoint which env var (and where it came from) actually drives BYOK.
  const isAccessToken = typeof byok === 'string'
  const driver = isAccessToken ? 'GSC_ACCESS_TOKEN' : 'GSC_REFRESH_TOKEN'
  const driverKeys = isAccessToken
    ? ['GSC_ACCESS_TOKEN', 'GOOGLE_ACCESS_TOKEN']
    : ['GSC_REFRESH_TOKEN', 'GOOGLE_REFRESH_TOKEN']
  const fromEnvFile = driverKeys.some(k => envKeys.has(k))
  const source = fromEnvFile ? '.env' : 'shell env'
  return `BYOK ${isAccessToken ? '(access-token)' : '(refresh-token)'} from ${source} via ${driver}`
}

async function checkAuth(envKeys: Set<string>): Promise<{ checks: Check[], liveToken: string | null }> {
  const checks: Check[] = []
  const byok = resolveBYOK()
  const tokens = await loadTokens()

  if (!byok && !tokens) {
    checks.push({ name: 'auth', status: 'fail', detail: 'no BYOK env vars and no saved tokens; run `gscdump init`' })
    return { checks, liveToken: null }
  }

  // Pull the client ID we'll be authenticating with, regardless of source.
  const clientId = resolveCliEnvironment().clientId ?? (await loadConfig()).clientId ?? null
  if (clientId)
    checks.push({ name: 'auth.client_id', status: 'info', detail: clientId })

  let liveToken: string | null = null
  let refreshError: string | null = null
  if (typeof byok === 'string') {
    liveToken = byok
  }
  else if (byok && 'getAccessToken' in byok) {
    liveToken = await byok.getAccessToken()
      .then(r => r.token ?? null)
      .catch((e: any) => {
        // ofetch errors carry .data with Google's payload; fall back to message.
        refreshError = e?.data?.error_description ?? e?.data?.error ?? e?.message ?? String(e)
        return null
      })
  }
  else if (tokens?.access_token) {
    liveToken = tokens.access_token
  }

  if (!liveToken) {
    const source = describeAuthSource(envKeys, byok)
    const detail = refreshError
      ? `${source} — refresh failed: ${refreshError} (token revoked / invalid — re-run \`gscdump auth login --force\` and update the source above)`
      : `${source} — no usable access token`
    checks.push({ name: 'auth', status: 'fail', detail })
    return { checks, liveToken: null }
  }

  const info = await ofetch<{ scope?: string, email?: string, expires_in?: number }>(
    'https://oauth2.googleapis.com/tokeninfo',
    { query: { access_token: liveToken } },
  ).catch((e: Error) => ({ error: e.message } as any))

  if ('error' in info) {
    checks.push({ name: 'auth', status: 'fail', detail: `tokeninfo failed: ${info.error}` })
    return { checks, liveToken: null }
  }

  checks.push({
    name: 'auth',
    status: 'pass',
    detail: describeAuthSource(envKeys, byok),
  })
  if (info.email)
    checks.push({ name: 'auth.account', status: 'pass', detail: info.email })

  const scopes = info.scope ? info.scope.split(/\s+/) : []
  const missing = missingRequiredScopes(scopes)
  if (missing.length > 0)
    checks.push({ name: 'auth.scopes', status: 'warn', detail: `missing: ${missing.join(', ')} — \`gscdump auth login --force\` to re-consent` })
  else
    checks.push({ name: 'auth.scopes', status: 'pass', detail: `${scopes.length} granted` })

  if (tokens?.expiry_date) {
    const expiresInMs = tokens.expiry_date - Date.now()
    if (expiresInMs < 0)
      checks.push({ name: 'auth.expiry', status: 'warn', detail: `expired ${new Date(tokens.expiry_date).toISOString()} — will refresh on next call` })
    else
      checks.push({ name: 'auth.expiry', status: 'pass', detail: `valid for ${Math.floor(expiresInMs / 60_000)}m` })
  }

  return { checks, liveToken }
}

async function checkTimeSkew(): Promise<Check[]> {
  // Google's load balancer Date header is authoritative; OAuth rejects if our
  // clock drifts more than ~5 min off. Some endpoints reject HEAD with 405 but
  // still return Date; ofetch.raw throws on non-2xx, so we read the response
  // either way via the error path.
  const dateHeader = await ofetch.raw('https://oauth2.googleapis.com/tokeninfo', {
    method: 'GET',
    timeout: FETCH_TIMEOUT_MS,
  })
    .then((r: Response) => r.headers.get('date'))
    .catch((e: any) => e?.response?.headers?.get('date') ?? null)
  if (!dateHeader)
    return [{ name: 'time', status: 'warn', detail: 'could not probe Google clock (no Date header)' }]

  const remoteMs = Date.parse(dateHeader)
  if (!Number.isFinite(remoteMs))
    return [{ name: 'time', status: 'warn', detail: `unparseable Date header: ${dateHeader}` }]

  const skewMs = Date.now() - remoteMs
  const sign = skewMs >= 0 ? '+' : ''
  const human = `${sign}${(skewMs / 1000).toFixed(1)}s`
  if (Math.abs(skewMs) > TIME_SKEW_WARN_MS)
    return [{ name: 'time', status: 'warn', detail: `local clock ${human} off Google — OAuth refresh may reject; sync your clock` }]
  return [{ name: 'time', status: 'pass', detail: `in sync (${human})` }]
}

async function checkDataDir(dataDir: string): Promise<Check[]> {
  const display = displayPath(dataDir)
  const stat = await fs.stat(dataDir).catch(() => null)
  if (!stat)
    return [{ name: 'dataDir', status: 'warn', detail: `${display} does not exist (will be created on first sync)` }]
  if (!stat.isDirectory())
    return [{ name: 'dataDir', status: 'fail', detail: `${display} is not a directory` }]

  const probe = `${dataDir}/.gscdump-doctor-probe`
  const writable = await fs.writeFile(probe, '')
    .then(() => fs.rm(probe))
    .then(() => true)
    .catch(() => false)
  return writable
    ? [{ name: 'dataDir', status: 'pass', detail: display }]
    : [{ name: 'dataDir', status: 'fail', detail: `${display} not writable` }]
}

async function checkStoreWatermarks(dataDir: string): Promise<Check[]> {
  const stat = await fs.stat(dataDir).catch(() => null)
  if (!stat?.isDirectory())
    return [{ name: 'store.watermarks', status: 'pass', detail: 'no store yet (run `gscdump sync`)' }]

  const store = createLocalStore({ dataDir })
  const watermarks = await store.engine.getWatermarks({ userId: store.userId }).catch(() => null)
  if (!watermarks || watermarks.length === 0)
    return [{ name: 'store.watermarks', status: 'pass', detail: 'no watermarks (run `gscdump sync`)' }]

  // Newest sync date per site (collapse table dimension).
  const bySite = new Map<string, string>()
  for (const w of watermarks) {
    const site = w.siteId ?? '(global)'
    const existing = bySite.get(site)
    if (!existing || w.newestDateSynced > existing)
      bySite.set(site, w.newestDateSynced)
  }

  const today = new Date().toISOString().slice(0, 10)
  const stale: Array<{ site: string, days: number }> = []
  let freshest: { site: string, days: number } | null = null
  for (const [site, newest] of bySite) {
    const days = Math.floor((Date.parse(today) - Date.parse(newest)) / 86_400_000)
    if (days > WATERMARK_STALE_DAYS_WARN)
      stale.push({ site, days })
    if (!freshest || days < freshest.days)
      freshest = { site, days }
  }

  if (stale.length > 0) {
    const sample = stale.slice(0, 3).map(s => `${s.site} (${s.days}d)`).join(', ')
    const more = stale.length > 3 ? ` +${stale.length - 3} more` : ''
    return [{ name: 'store.watermarks', status: 'warn', detail: `${stale.length}/${bySite.size} site(s) stale >${WATERMARK_STALE_DAYS_WARN}d: ${sample}${more}` }]
  }
  const tail = freshest ? `, freshest ${freshest.days}d ago` : ''
  return [{ name: 'store.watermarks', status: 'pass', detail: `${bySite.size} site(s)${tail}` }]
}

async function checkApiReachable(name: string, url: string): Promise<Check[]> {
  const reachable = await ofetch.raw(url, {
    method: 'GET',
    timeout: FETCH_TIMEOUT_MS,
  }).then(() => true).catch(() => false)
  return [{
    name,
    status: reachable ? 'pass' : 'warn',
    detail: reachable ? 'reachable' : `${new URL(url).hostname} unreachable (network/firewall?)`,
  }]
}

async function checkGscSites(): Promise<Check[]> {
  // Combines #1 (defaultSite validity) + #7 (real ping) — one auth'd API
  // call covers both signals.
  const config = await loadConfig()
  const auth = await resolveAuth({ interactive: false, config }).catch(() => null)
  if (!auth)
    return [{ name: 'gsc.sites', status: 'warn', detail: 'skipped (no usable auth)' }]

  const client = googleSearchConsole(auth as any)
  const sites = await client.sites().catch((e: Error) => e)
  if (sites instanceof Error)
    return [{ name: 'gsc.sites', status: 'fail', detail: `sites() failed: ${sites.message}` }]

  const checks: Check[] = []
  const verified = sites.filter(s => s.permissionLevel !== 'siteUnverifiedUser').length
  checks.push({ name: 'gsc.sites', status: 'pass', detail: `${sites.length} site(s) accessible (${verified} verified)` })

  if (config.defaultSite) {
    const match = sites.find(s => s.siteUrl === config.defaultSite || (s.siteUrl ?? '').includes(String(config.defaultSite)))
    checks.push(match
      ? { name: 'config.defaultSite', status: 'pass', detail: `${config.defaultSite} ✓` }
      : { name: 'config.defaultSite', status: 'fail', detail: `${config.defaultSite} not in verified site list` },
    )
  }

  return checks
}

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Run health checks (env, auth, scopes, time, dataDir, store, GSC reachability + ping, defaultSite)',
  },
  args: {
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { dataDir } = await createCommandContext()
    // Cheap probes run unconditionally and in parallel. The auth check yields
    // the live token used by gsc.sites, so it stays sequential to that.
    // env runs first so the auth check can report which env var drives BYOK.
    const envResult = await checkEnv()
    const [authResult, timeChecks, dataDirChecks, watermarkChecks, gscApi, indexingApi, siteVerificationApi] = await Promise.all([
      checkAuth(envResult.envKeys),
      checkTimeSkew(),
      checkDataDir(dataDir),
      checkStoreWatermarks(dataDir),
      checkApiReachable('gsc.api', 'https://searchconsole.googleapis.com/$discovery/rest?version=v1'),
      checkApiReachable('indexing.api', 'https://indexing.googleapis.com/$discovery/rest?version=v3'),
      checkApiReachable('siteverification.api', 'https://www.googleapis.com/discovery/v1/apis/siteVerification/v1/rest'),
    ])

    // gsc.sites needs auth resolved already; only run if auth passed.
    const sitesChecks = authResult.liveToken
      ? await checkGscSites()
      : [{ name: 'gsc.sites', status: 'warn' as const, detail: 'skipped (auth failed)' }]

    const all = [
      ...envResult.checks,
      ...authResult.checks,
      ...timeChecks,
      ...dataDirChecks,
      ...watermarkChecks,
      ...gscApi,
      ...indexingApi,
      ...siteVerificationApi,
      ...sitesChecks,
    ]

    if (json) {
      console.log(JSON.stringify({ checks: all, ok: all.every(c => c.status !== 'fail') }, null, 2))
      return
    }

    const ICONS: Record<Check['status'], string> = {
      pass: '\x1B[32m✓\x1B[0m',
      warn: '\x1B[33m!\x1B[0m',
      fail: '\x1B[31m✗\x1B[0m',
      info: '\x1B[34mℹ\x1B[0m',
    }
    console.log()
    for (const c of all) {
      const detail = c.detail ? ` \x1B[90m${c.detail}\x1B[0m` : ''
      console.log(`  ${ICONS[c.status]} ${c.name}${detail}`)
    }
    console.log()
    const failed = all.filter(c => c.status === 'fail')
    if (failed.length > 0) {
      logger.error(`${failed.length} check(s) failed`)
      process.exit(1)
    }
    const warned = all.filter(c => c.status === 'warn')
    if (warned.length > 0)
      logger.warn(`${warned.length} warning(s)`)
    else
      logger.success('All checks passed')
  },
})
