import type { GoogleSearchConsoleClient } from '../../src/core/client'
import type { ApiSite } from '../../src/core/types'
import { describe, expect, it, vi } from 'vitest'
import { fetchSitesWithSitemaps } from '../../src/api/sites'

describe('fetchSitesWithSitemaps', () => {
  it('bounds sitemap-list fan-out and preserves site order', async () => {
    const sites: ApiSite[] = Array.from({ length: 12 }, (_, index) => ({
      siteUrl: `sc-domain:site-${index}.test`,
      permissionLevel: 'siteOwner',
    }))
    let active = 0
    let peak = 0
    const list = vi.fn(async (siteUrl: string) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return [{ path: `${siteUrl}/sitemap.xml` }]
    })
    const client = {
      sites: vi.fn(async () => sites),
      sitemaps: { list },
    } as unknown as GoogleSearchConsoleClient

    const result = await fetchSitesWithSitemaps(client)

    expect(peak).toBeLessThanOrEqual(4)
    expect(list).toHaveBeenCalledTimes(sites.length)
    expect(result.map(site => site.siteUrl)).toEqual(sites.map(site => site.siteUrl))
  })

  it('honours an explicit concurrency and isolates per-site failures', async () => {
    const sites: ApiSite[] = [
      { siteUrl: 'sc-domain:one.test', permissionLevel: 'siteOwner' },
      { siteUrl: 'sc-domain:two.test', permissionLevel: 'siteFullUser' },
      { siteUrl: 'sc-domain:unverified.test', permissionLevel: 'siteUnverifiedUser' },
    ]
    const client = {
      sites: vi.fn(async () => sites),
      sitemaps: {
        list: vi.fn(async (siteUrl: string) => {
          if (siteUrl.includes('two'))
            throw new Error('forbidden')
          return [{ path: `${siteUrl}/sitemap.xml` }]
        }),
      },
    } as unknown as GoogleSearchConsoleClient

    const result = await fetchSitesWithSitemaps(client, { concurrency: 1 })

    expect(result).toHaveLength(2)
    expect(result[0]!.sitemaps).toHaveLength(1)
    expect(result[1]!.sitemaps).toEqual([])
  })
})
