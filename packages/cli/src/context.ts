import type { OAuth2Client } from 'google-auth-library'
import type { googleSearchConsole } from 'gscdump'
import type { GscdumpConfig } from './config'
import type { LocalStore } from './local-store'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { googleSearchConsole as createGsc } from 'gscdump'
import { getAuth } from './auth'
import { loadConfig, resolveDataDir } from './config'
import { createLocalStore } from './local-store'
import { logger } from './utils'

export interface GscSite {
  siteUrl: string
  permissionLevel: string
}

type GscClient = ReturnType<typeof googleSearchConsole>

export interface CommandContext {
  config: GscdumpConfig
  /** Non-null only when `needsAuth: true`. */
  auth: OAuth2Client | null
  /** Non-null only when `needsAuth: true`; wraps `auth`. */
  client: GscClient | null
  /** Non-null only when `needsStore: true`. */
  store: LocalStore | null
  /** Fetch verified GSC sites for the authed user. Requires `needsAuth`. */
  loadSites: () => Promise<GscSite[]>
  /**
   * Resolve a site URL: honour `target` if it matches, fall back to single-site
   * shortcut, otherwise prompt. Uses `config.defaultSite` when `target` omitted.
   * Requires `needsAuth`.
   */
  resolveSite: (target?: string) => Promise<string>
}

export interface CommandContextOptions {
  /** Load OAuth client + GSC client. Default false. */
  needsAuth?: boolean
  /** Load local storage facade. Default false. */
  needsStore?: boolean
  /** Allow interactive OAuth prompts. Default false (CLI commands opt-in). */
  interactive?: boolean
}

export async function createCommandContext(
  opts: CommandContextOptions = {},
): Promise<CommandContext> {
  const { needsAuth = false, needsStore = false, interactive = false } = opts
  const config = await loadConfig()
  const auth = needsAuth ? await getAuth({ interactive, config }) : null
  const client = auth ? createGsc(auth) : null
  const store = needsStore ? createLocalStore({ dataDir: resolveDataDir(config) }) : null

  const loadSites = async (): Promise<GscSite[]> => {
    if (!client)
      throw new Error('loadSites requires needsAuth: true')
    const gscSites = await client.sites().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })
    return gscSites
      .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
      .map(s => ({ siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel || 'unknown' }))
  }

  const resolveSite = async (target?: string): Promise<string> => {
    const hint = target ?? config.defaultSite
    const sites = await loadSites()
    if (sites.length === 0) {
      logger.error('No verified sites found')
      process.exit(1)
    }
    if (hint) {
      const match = sites.find(s => s.siteUrl === hint || s.siteUrl.includes(hint))
      if (match)
        return match.siteUrl
    }
    if (sites.length === 1)
      return sites[0].siteUrl
    const selected = await select({
      message: 'Select a site',
      options: sites.map(s => ({ value: s.siteUrl, label: s.siteUrl })),
    })
    if (isCancel(selected)) {
      cancel('Cancelled')
      process.exit(0)
    }
    return selected as string
  }

  return { config, auth, client, store, loadSites, resolveSite }
}
