import type { OAuth2Client } from 'google-auth-library'
import type { SiteCandidate, SiteResolution } from 'gscdump'
import type { googleSearchConsole, Auth as GscAuth } from 'gscdump/client'
import type { FetchOptions } from 'ofetch'
import type { BYOKOptions } from './auth'
import type { Authentication } from './auth-state'
import type { GscdumpConfig } from './config'
import type { LocalStore } from './local-store'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { parseGscSiteUrl, resolveSiteInput } from 'gscdump'
import { googleSearchConsole as createGsc } from 'gscdump/client'
import { resolveAuth } from './auth'
import { resolveAuthentication } from './auth-state'
import { createCloudGoogleClient } from './cloud-google'
import { loadResolvedConfig } from './config'
import { createLocalStore } from './local-store'
import { listStoreSites } from './store-sites'

export interface GscSite {
  siteUrl: string
  permissionLevel: string
}

type GscClient = ReturnType<typeof googleSearchConsole>

export interface CommandContext {
  authentication: Authentication
  config: GscdumpConfig
  /** Fully resolved local data directory from the same config load. */
  dataDir: string
  /** Auth used to construct the GSC client; OAuth2Client for saved-token flow, lightweight `Auth` for BYOK. */
  auth: OAuth2Client | GscAuth | null
  /** Non-null only when `needsAuth: true`; wraps `auth`. */
  client: GscClient | null
  /** Non-null only when `needsStore: true`. */
  store: LocalStore | null
  /** Fetch verified GSC sites for the authed user. Requires `needsAuth`. */
  loadSites: () => Promise<GscSite[]>
  /**
   * Resolve `--site` input (or `config.defaultSite`) to one Site URL. Store
   * Sites come first. On a miss, the Search Console Site list is used when
   * the context has auth and `scope` is `account`. Without input, a single
   * Site is picked, a terminal shows a picker, and anything else throws.
   */
  resolveSite: (target?: string, options?: ResolveSiteOptions) => Promise<string>
  /** Match one input to a Site without throwing, with the same sources as `resolveSite`. */
  matchSite: (input: string, options?: ResolveSiteOptions) => Promise<SiteResolution>
}

/**
 * `store` resolves only Sites with local data and never calls Google.
 * `account` (default) also asks Search Console on a Store miss.
 */
export type SiteScope = 'store' | 'account'

export interface ResolveSiteOptions {
  scope?: SiteScope
}

export interface CommandContextOptions {
  /** Load OAuth client + GSC client. Default false. */
  needsAuth?: boolean
  /** Load local storage facade. Default false. */
  needsStore?: boolean
  /** Allow interactive OAuth prompts. Default false (CLI commands opt-in). */
  interactive?: boolean
  /** Per-call BYOK overrides; falls back to env vars. */
  byok?: BYOKOptions
  /** Forwarded to googleSearchConsole(); used to surface --retries on commands. */
  fetchOptions?: FetchOptions
}

const FULL_SITE_URL_RE = /^(?:sc-domain:|https?:\/\/)/i

export async function createCommandContext(
  opts: CommandContextOptions = {},
): Promise<CommandContext> {
  const { needsAuth = false, needsStore = false, interactive = false, byok, fetchOptions } = opts
  const { config, dataDir } = await loadResolvedConfig()
  const authentication = needsAuth ? await resolveAuthentication() : { _tag: 'Local' } as const
  const auth = needsAuth && authentication._tag === 'Local' ? await resolveAuth({ interactive, config, byok }) : null
  const client = needsAuth && authentication._tag === 'Cloud'
    ? createCloudGoogleClient(authentication, fetchOptions)
    : auth ? createGsc(auth as GscAuth, { fetchOptions }) : null
  const store = needsStore ? createLocalStore({ dataDir }) : null

  const loadSites = async (): Promise<GscSite[]> => {
    if (!client)
      throw new Error('loadSites requires needsAuth: true')
    const gscSites = await client.sites()
    return gscSites
      .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
      .map(s => ({ siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel || 'unknown' }))
  }

  const storeCandidates = async (): Promise<SiteCandidate[]> =>
    (await listStoreSites(dataDir)).map(site => ({ siteUrl: site.siteUrl, inStore: true }))
  const asksGoogle = (options: ResolveSiteOptions): boolean => options.scope !== 'store' && client !== null

  const matchSite = async (input: string, options: ResolveSiteOptions = {}): Promise<SiteResolution> => {
    const local = await storeCandidates()
    const fromStore = resolveSiteInput(input, local)
    if (!asksGoogle(options) || (fromStore.kind === 'resolved' && (fromStore.via === 'exact' || !FULL_SITE_URL_RE.test(input.trim()))))
      return fromStore
    // A full Site URL may name an account property exactly, which beats a
    // Store Site that only shares its root.
    return resolveSiteInput(input, [...local, ...await loadSites()])
  }

  const resolveSite = async (target?: string, options: ResolveSiteOptions = {}): Promise<string> => {
    const hint = target?.trim() || config.defaultSite
    const askGoogle = asksGoogle(options)
    if (hint) {
      const resolution = await matchSite(hint, options)
      if (resolution.kind === 'resolved')
        return resolution.siteUrl
      throw new Error(formatSiteResolution(resolution, askGoogle ? 'account' : 'store'))
    }

    const local = await storeCandidates()
    const pool = [...new Set([...local, ...(askGoogle ? await loadSites() : [])].map(site => site.siteUrl))]
    if (pool.length === 0) {
      throw new Error(askGoogle
        ? 'No verified Sites found. Add the Site in Search Console, then run `gscdump sites`.'
        : 'The Store has no data. Run `gscdump sync --site example.com` first.')
    }
    if (pool.length === 1)
      return pool[0]!
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(`Pass --site. Sites: ${pool.join(', ')}`)
    const selected = await select({
      message: 'Select a Site',
      options: pool.map(siteUrl => ({ value: siteUrl, label: siteUrl })),
    })
    if (isCancel(selected)) {
      cancel('Cancelled')
      process.exit(0)
    }
    return selected as string
  }

  return { config, dataDir, authentication, auth, client, store, loadSites, matchSite, resolveSite }
}

/**
 * The short `--site` value for a Site URL: no `sc-domain:`, no `https://`.
 * An `http://` Site keeps its scheme, because the short form would pick an
 * HTTPS property first.
 */
export function siteArg(siteUrl: string): string {
  return siteUrl.startsWith('http://') ? siteUrl : parseGscSiteUrl(siteUrl).displayLabel
}

/** Plain-text error for a Site that did not resolve. */
export function formatSiteResolution(resolution: Exclude<SiteResolution, { kind: 'resolved' }>, scope: SiteScope): string {
  switch (resolution.kind) {
    case 'ambiguous':
      return `"${resolution.input}" matches more than one Site: ${resolution.candidates.join(', ')}. Pass one of these Site URLs to --site.`
    case 'covered-by-parent':
      return `"${resolution.input}" is part of the Site ${resolution.parent}. `
        + `Filter its pages instead: --site ${siteArg(resolution.parent)} --page ~${resolution.input.trim().replace(/^[a-z]+:\/\//i, '')}.`
    case 'not-found': {
      if (scope === 'store') {
        const sync = `gscdump sync --site ${siteArg(resolution.input.trim())}`
        return resolution.known.length === 0
          ? `The Store has no data. Run \`${sync}\` first.`
          : `The Store has no data for "${resolution.input}". Local Sites: ${resolution.known.join(', ')}. Run \`${sync}\` to add it.`
      }
      return resolution.known.length === 0
        ? `No Site matches "${resolution.input}". Your account has no verified Sites.`
        : `No Site matches "${resolution.input}". Sites: ${resolution.known.join(', ')}.`
    }
  }
}
