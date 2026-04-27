import type { CloudGscDriver, DriverSiteWithSync } from './types'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { consola } from 'consola'
import { formatErrorForCli } from 'gscdump'

export const logger = consola.withTag('gscdump-cloud')

export const VERSION = '1.0.0'

export const DEFAULT_CLOUD_URL = 'https://gscdump.com'

export function exitOnError<T>(promise: Promise<T>, context: string): Promise<T> {
  return promise.catch((e: unknown) => {
    console.error()
    console.error(`${context}:`)
    console.error(formatErrorForCli(e))
    console.error()
    process.exit(1)
  })
}

export async function loadSites(driver: CloudGscDriver): Promise<DriverSiteWithSync[]> {
  const sites = await exitOnError(driver.sitesWithSync(), 'Failed to fetch sites')
  if (sites.length === 0) {
    logger.error('No registered sites. Run gscdump-cloud register first.')
    process.exit(1)
  }
  return sites
}

export async function resolveSiteUrl(sites: DriverSiteWithSync[], target?: string): Promise<string> {
  if (target) {
    const match = sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
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
