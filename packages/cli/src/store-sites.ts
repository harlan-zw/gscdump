// The Store keys each Site by `encodeSiteId(siteUrl)`. That encoding is lossy:
// `http://x.com/` and `https://x.com/` share `h_x.com`, and paths collapse to
// `_`. So `sync` records the real Site URL for each siteId in `sites.json`,
// and refuses a Site whose siteId already holds data for a different Site,
// whether the owner is recorded in the map or inferred from `decodeSiteId`.
// Stores created before the map fall back to `decodeSiteId`.
//
// Syncs run in parallel (`--all-sites`, several processes). Every change to
// the map takes a lock, re-reads the map, and replaces the file atomically.

import type { Result } from 'gscdump/result'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { err, ok } from 'gscdump/result'
import { decodeSiteId, encodeSiteId } from 'gscdump/tenant'
import { lock } from 'proper-lockfile'
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

// A decodeSiteId result that is a clean https origin: no `_`, because a
// collapsed path or port always leaves one behind. Only then does the
// decoded label name the pre-map owner instead of garbage.
const DECODED_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+\/$/i

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
 * data exists. The same holds for a Store created before the map, whose
 * only owner label is the decoded origin. A siteId without data can be
 * claimed again.
 */
export function claimSiteId(map: SiteMap, siteUrl: string, hasData: boolean): Result<SiteMap, SiteIdCollision> {
  const siteId = encodeSiteId(siteUrl)
  const existing = map[siteId]
  if (existing === undefined && hasData) {
    // The pre-map owner has no map entry. Its decoded origin is what every
    // reader falls back to, so it wins like a recorded URL; a claimant that
    // disagrees would silently relabel the data.
    const decoded = decodeSiteId(siteId)
    if (DECODED_ORIGIN_RE.test(decoded) && decoded !== siteUrl)
      return err({ kind: 'site-id-collision', siteId, siteUrl, existing: decoded })
  }
  if (existing !== undefined && existing !== siteUrl && hasData)
    return err({ kind: 'site-id-collision', siteId, siteUrl, existing })
  return ok(existing === siteUrl ? map : { ...map, [siteId]: siteUrl })
}

async function writeSiteMap(dataDir: string, userId: string, sites: SiteMap): Promise<void> {
  const file = siteMapPath(dataDir, userId)
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify({ version: 1, sites }, null, 2)}\n`)
  await fs.rename(temp, file)
}

// Writers in this process wait here, so they never contend for the file lock.
const siteMapQueues = new Map<string, Promise<void>>()

async function lockSiteMapFile<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // `proper-lockfile` creates `sites.json.lock` beside the map.
  const release = await lock(file, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 40, minTimeout: 25, maxTimeout: 500, factor: 1.5 },
  })
  return await fn().finally(() => release().catch((error: unknown) => {
    // The change is written. A lock left behind goes stale after 30 seconds.
    console.warn(`[gscdump] Could not release the Site map lock for ${file}.`, error)
  }))
}

/** Run `fn` while no other writer, in any process, changes the Site map. */
async function withSiteMapLock<T>(dataDir: string, userId: string, fn: () => Promise<T>): Promise<T> {
  const file = siteMapPath(dataDir, userId)
  const run = (siteMapQueues.get(file) ?? Promise.resolve()).then(() => lockSiteMapFile(file, fn))
  const tail = run.then(() => undefined, () => {
    // The caller receives this failure from `run`. The next writer still runs.
  })
  siteMapQueues.set(file, tail)
  void tail.then(() => {
    if (siteMapQueues.get(file) === tail)
      siteMapQueues.delete(file)
  })
  return await run
}

/**
 * Record the Site URL for its siteId before a sync writes data. With
 * `write: false` it only checks for a collision, for `sync --dry-run`.
 */
export async function recordStoreSite(dataDir: string, siteUrl: string, options: { userId?: string, write?: boolean } = {}): Promise<Result<void, SiteIdCollision>> {
  const { userId = 'local', write = true } = options
  const claim = async (): Promise<Result<SiteMap, SiteIdCollision>> => {
    const [map, siteIds] = await Promise.all([readSiteMap(dataDir, userId), listSiteIds(dataDir, userId)])
    const claimed = claimSiteId(map, siteUrl, siteIds.includes(encodeSiteId(siteUrl)))
    if (claimed.ok && write && claimed.value !== map)
      await writeSiteMap(dataDir, userId, claimed.value)
    return claimed
  }
  const result = write ? await withSiteMapLock(dataDir, userId, claim) : await claim()
  return result.ok ? ok(undefined) : result
}

/**
 * Remove what the engine purge leaves for a Site: its directory, including
 * entity files, and its map entry. Call it after `purgeTenant`.
 */
export async function removeStoreSite(dataDir: string, siteId: string, userId = 'local'): Promise<void> {
  if (!SITE_ID_DIR_RE.test(siteId))
    throw new Error(`Refusing to remove "${siteId}": it is not a Site ID.`)
  await withSiteMapLock(dataDir, userId, async () => {
    await fs.rm(path.join(tenantDir(dataDir, userId), siteId), { recursive: true, force: true })
    const map = await readSiteMap(dataDir, userId)
    if (!(siteId in map))
      return
    const { [siteId]: _removed, ...rest } = map
    await writeSiteMap(dataDir, userId, rest)
  })
}

export function formatSiteIdCollision(collision: SiteIdCollision): string {
  return `The Store keeps ${collision.existing} under the same ID as ${collision.siteUrl}. `
    + `The two Sites cannot share one Store. `
    + `If you no longer need the data for ${collision.existing}, run \`gscdump store rm-site ${collision.existing}\`, then sync again.`
}
