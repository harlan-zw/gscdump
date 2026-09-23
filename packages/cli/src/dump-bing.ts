// Bing step of `gscdump dump`: export the Bing sites that match the dumped
// Google sites, through the same paths `gscdump bing dump` uses. Bing is
// optional, so a missing login is a skip and a failure is reported.

import type { BingDumpSummary } from './bing-data'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveAuthentication } from './auth-state'
import { getBingClient, inspectBingCredentials } from './bing-auth'
import { dumpBingSite, parseBingDumpOptions, unwrapBing } from './bing-data'
import { dumpHostedBingSite, listHostedBingSites } from './bing-hosted'
import { urlInProperty } from './local-entities'

export interface BingDumpFile {
  dataset: string
  path: string
  bytes: number
  rows: number
}

export type BingDumpStep
  = | { _tag: 'disabled' }
    | { _tag: 'skipped', reason: string }
    | {
      _tag: 'dumped'
      sites: Array<{ siteUrl: string, files: BingDumpFile[] }>
      failures: Array<{ siteUrl: string, error: string }>
    }
    | { _tag: 'failed', reason: string }

/** Bing site URLs that belong to one of the Google properties. `all` keeps every site. */
export function matchBingSites(bingSites: readonly string[], googleSites: readonly string[] | 'all'): string[] {
  if (googleSites === 'all')
    return [...bingSites]
  return bingSites.filter(bing => googleSites.some(google => urlInProperty(google, bing) || urlInProperty(bing, google)))
}

async function withSizes(summary: BingDumpSummary): Promise<{ siteUrl: string, files: BingDumpFile[] }> {
  const files = await Promise.all(summary.files.map(async file => ({
    dataset: file.dataset,
    path: file.path,
    bytes: (await fs.stat(file.path)).size,
    rows: file.rows,
  })))
  return { siteUrl: summary.siteUrl, files }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write Bing datasets under `<outDir>/bing/`. Bing files use JSON, NDJSON,
 * or CSV; a Parquet dump writes its Bing files as JSON.
 */
export async function dumpBing(opts: {
  googleSites: readonly string[] | 'all'
  outDir: string
  format: 'parquet' | 'json' | 'ndjson' | 'csv'
}): Promise<BingDumpStep> {
  const options = parseBingDumpOptions({ format: opts.format === 'parquet' ? 'json' : opts.format })
  const bingDir = path.join(opts.outDir, 'bing')
  const sites: Array<{ siteUrl: string, files: BingDumpFile[] }> = []
  const failures: Array<{ siteUrl: string, error: string }> = []

  const authentication = await resolveAuthentication()
  if (authentication._tag === 'Cloud') {
    const hosted = (await listHostedBingSites(authentication)).filter(site => site.connection._tag === 'connected')
    const wanted = new Set(matchBingSites(hosted.map(site => site.siteUrl), opts.googleSites))
    const selected = hosted.filter(site => wanted.has(site.siteUrl))
    if (selected.length === 0)
      return { _tag: 'skipped', reason: 'No connected Bing site matches the dumped sites.' }
    for (const site of selected) {
      await dumpHostedBingSite(authentication, site, bingDir, options)
        .then(async summary => sites.push(await withSizes(summary)))
        .catch((error: unknown) => failures.push({ siteUrl: site.siteUrl, error: message(error) }))
    }
    return { _tag: 'dumped', sites, failures }
  }

  if ((await inspectBingCredentials())._tag === 'Missing')
    return { _tag: 'skipped', reason: 'No Bing login. Run `gscdump bing login` to include Bing.' }
  const client = await getBingClient()
  const verified = unwrapBing(await client.getUserSites({ signal: AbortSignal.timeout(30_000) }))
    .filter(site => site.isVerified)
    .map(site => site.url)
  const selected = matchBingSites(verified, opts.googleSites)
  if (selected.length === 0)
    return { _tag: 'skipped', reason: 'No verified Bing site matches the dumped sites.' }
  for (const siteUrl of selected) {
    await dumpBingSite(client, siteUrl, bingDir, options)
      .then(async summary => sites.push(await withSizes(summary)))
      .catch((error: unknown) => failures.push({ siteUrl, error: message(error) }))
  }
  return { _tag: 'dumped', sites, failures }
}
