// The Store keys each Site by `encodeSiteId(siteUrl)`. That encoding is lossy:
// `http://x.com/` and `https://x.com/` share `h_x.com`, and paths collapse to
// `_`. So `sync` records the real Site URL for each siteId in `sites.json`,
// and refuses a Site whose siteId already holds data for a different Site.
// Stores created before the map fall back to `decodeSiteId`.

import type { Result } from 'gscdump/result'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { err, ok } from 'gscdump/result'
import { decodeSiteId, encodeSiteId } from 'gscdump/tenant'
import { z } from 'zod'

export interface StoreSite {
  siteId: string
  siteUrl: string
}

export interface SiteIdCollision {
  kind: 'site-id-collision'
  siteId: string
  siteUrl: string
  existing: string
}

export type SiteMap = Readonly<Record<string, string>>

const siteMapSchema = z.object({
  version: z.literal(1),
  sites: z.record(z.string(), z.string()),
})

const SITE_ID_DIR_RE = /^[dh]_[\w.-]+$/

function tenantDir(dataDir: string, userId: string): string {
  return path.join(dataDir, `u_${userId}`)
}

function siteMapPath(dataDir: string, userId: string): string {
  return path.join(tenantDir(dataDir, userId), 'sites.json')
}

function ignoreMissing<T>(fallback: T): (error: NodeJS.ErrnoException) => T {
  return (error) => {
    if (error.code === 'ENOENT')
      return fallback
    throw error
  }
}

export async function readSiteMap(dataDir: string, userId = 'local'): Promise<SiteMap> {
  const file = siteMapPath(dataDir, userId)
  const body = await fs.readFile(file, 'utf8').catch(ignoreMissing(null))
  if (body === null)
    return {}
  const parsed = siteMapSchema.safeParse(await Promise.resolve().then(() => JSON.parse(body)).catch(() => undefined))
  if (!parsed.success)
    throw new Error(`The Site map at ${file} is invalid. Delete it, then run gscdump sync again.`)
  return parsed.data.sites
}

async function listSiteIds(dataDir: string, userId: string): Promise<string[]> {
  const entries = await fs.readdir(tenantDir(dataDir, userId), { withFileTypes: true }).catch(ignoreMissing([]))
  return entries.filter(entry => entry.isDirectory() && SITE_ID_DIR_RE.test(entry.name)).map(entry => entry.name)
}

/** Sites with a directory in the Store, with their real Site URLs. */
export async function listStoreSites(dataDir: string, userId = 'local'): Promise<StoreSite[]> {
  const [map, siteIds] = await Promise.all([readSiteMap(dataDir, userId), listSiteIds(dataDir, userId)])
  return siteIds.map(siteId => ({ siteId, siteUrl: map[siteId] ?? decodeSiteId(siteId) }))
}

/** The Site URL for a siteId, from the map when known. */
export function siteUrlForId(map: SiteMap, siteId: string): string {
  return map[siteId] ?? decodeSiteId(siteId)
}

/**
 * Decide if `siteUrl` may own `siteId`. A recorded Site URL wins while its
 * data exists. A siteId without data can be claimed again.
 */
export function claimSiteId(map: SiteMap, siteUrl: string, hasData: boolean): Result<SiteMap, SiteIdCollision> {
  const siteId = encodeSiteId(siteUrl)
  const existing = map[siteId]
  if (existing !== undefined && existing !== siteUrl && hasData)
    return err({ kind: 'site-id-collision', siteId, siteUrl, existing })
  return ok(existing === siteUrl ? map : { ...map, [siteId]: siteUrl })
}

async function writeSiteMap(dataDir: string, userId: string, sites: SiteMap): Promise<void> {
  await fs.mkdir(tenantDir(dataDir, userId), { recursive: true })
  const file = siteMapPath(dataDir, userId)
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify({ version: 1, sites }, null, 2)}\n`)
  await fs.rename(temp, file)
}

/**
 * Record the Site URL for its siteId before a sync writes data. With
 * `write: false` it only checks for a collision, for `sync --dry-run`.
 */
export async function recordStoreSite(dataDir: string, siteUrl: string, options: { userId?: string, write?: boolean } = {}): Promise<Result<void, SiteIdCollision>> {
  const { userId = 'local', write = true } = options
  const map = await readSiteMap(dataDir, userId)
  const siteIds = await listSiteIds(dataDir, userId)
  const claim = claimSiteId(map, siteUrl, siteIds.includes(encodeSiteId(siteUrl)))
  if (!claim.ok)
    return claim
  if (write && claim.value !== map)
    await writeSiteMap(dataDir, userId, claim.value)
  return ok(undefined)
}

/**
 * Remove what the engine purge leaves for a Site: its directory, including
 * entity files, and its map entry. Call it after `purgeTenant`.
 */
export async function removeStoreSite(dataDir: string, siteId: string, userId = 'local'): Promise<void> {
  if (!SITE_ID_DIR_RE.test(siteId))
    throw new Error(`Refusing to remove "${siteId}": it is not a Site ID.`)
  await fs.rm(path.join(tenantDir(dataDir, userId), siteId), { recursive: true, force: true })
  const map = await readSiteMap(dataDir, userId)
  if (!(siteId in map))
    return
  const { [siteId]: _removed, ...rest } = map
  await writeSiteMap(dataDir, userId, rest)
}

export function formatSiteIdCollision(collision: SiteIdCollision): string {
  return `The Store keeps ${collision.existing} under the same ID as ${collision.siteUrl}. `
    + `The two Sites cannot share one Store. `
    + `If you no longer need the data for ${collision.existing}, run \`gscdump store rm-site ${collision.existing}\`, then sync again.`
}
