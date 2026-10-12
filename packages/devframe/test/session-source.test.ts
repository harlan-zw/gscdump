import { describe, expect, it, vi } from 'vitest'
import { createPageStatsReader } from '../src/reader'
import { createSessionSource } from '../src/sources/session'

const ORIGIN = 'https://gscdump.test'
const NOW = Date.parse('2026-10-06T12:00:00Z')

interface SiteFixture {
  id: string
  label: string
  hostname: string
  oldestDateSynced: string
  newestDateSynced: string
}

const EXAMPLE: SiteFixture = { id: 's_example', label: 'example.com', hostname: 'example.com', oldestDateSynced: '2026-01-01', newestDateSynced: '2026-09-30' }
const BLOG: SiteFixture = { id: 's_blog', label: 'blog.example.com', hostname: 'blog.example.com', oldestDateSynced: '2026-01-01', newestDateSynced: '2026-09-30' }

interface Recorded {
  url: string
  credentials: RequestCredentials | undefined
  body: any
}

/** A fake gscdump.com: the session Site list and the archetype route. */
function fakeDashboard(options: { sites?: SiteFixture[], signedIn?: boolean, archetype?: (query: any) => Response } = {}) {
  const requests: Recorded[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, credentials: init?.credentials, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (options.signedIn === false)
      return Response.json({ statusCode: 401, message: 'Not authenticated' }, { status: 401 })
    if (url === `${ORIGIN}/api/__gsc/sites`)
      return Response.json(options.sites ?? [EXAMPLE, BLOG])
    if (url.endsWith('/archetype-query'))
      return (options.archetype ?? defaultArchetype)(requests.at(-1)!.body)
    return Response.json({ message: 'not found' }, { status: 404 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests }
}

function defaultArchetype(query: any): Response {
  if (query.archetype === 'entity-daily-timeseries') {
    return Response.json({
      archetype: query.archetype,
      source: 'server-r2-sql',
      rows: [
        { date: '2026-09-20', clicks: 2, impressions: 20, ctr: 0.1, position: 4 },
        { date: '2026-09-30', clicks: 3, impressions: 30, ctr: 0.1, position: 6 },
      ],
    })
  }
  return Response.json({
    archetype: query.archetype,
    source: 'server-r2-sql',
    rows: [{ query: 'example query', clicks: 3, impressions: 30, ctr: 0.1, position: 6 }],
  })
}

function reader(fetch: typeof globalThis.fetch) {
  return createPageStatsReader({ siteFromPage: true }, createSessionSource({ origin: ORIGIN, fetch }), () => NOW)
}

describe('extension context', () => {
  it('picks the Site that covers the tab\'s host', async () => {
    const context = await reader(fakeDashboard({}).fetch).context(null, 'https://blog.example.com/posts/one')

    expect(context._tag === 'Ready' && context.site.siteId).toBe('s_blog')
  })

  it('names the host when no Site covers it', async () => {
    const context = await reader(fakeDashboard({}).fetch).context(null, 'https://other.dev/')

    expect(context).toEqual({ _tag: 'NoSiteForPage', host: 'other.dev' })
  })

  it('asks for a pick when two Sites cover the host, and keeps the pick', async () => {
    const twin = { ...EXAMPLE, id: 's_example_team' }
    const read = reader(fakeDashboard({ sites: [EXAMPLE, twin] }).fetch)

    expect((await read.context(null, 'https://example.com/'))._tag).toBe('SiteRequired')
    const picked = await read.context('s_example_team', 'https://example.com/')
    expect(picked._tag === 'Ready' && picked.site.siteId).toBe('s_example_team')
  })

  it('sends the user to sign in when gscdump.com has no session', async () => {
    const context = await reader(fakeDashboard({ signedIn: false }).fetch).context(null, 'https://example.com/')

    expect(context).toEqual({ _tag: 'SignedOut', signInUrl: `${ORIGIN}/auth/google` })
  })
})

describe('extension page stats', () => {
  it('reads the record with the login cookie and filters both reads to the page', async () => {
    const dashboard = fakeDashboard({})

    const stats = await reader(dashboard.fetch).pageStats({ page: '/posts/one', period: '7d', siteId: 's_example' })

    expect(stats._tag === 'Ok' && stats.totals).toEqual({ clicks: 3, impressions: 30, ctr: 0.1, position: 6 })
    const reads = dashboard.requests.filter(r => r.url.endsWith('/archetype-query'))
    expect(reads.every(r => r.credentials === 'include')).toBe(true)
    expect(reads.map(r => r.body.entity?.value ?? r.body.facets?.[0]?.value)).toEqual(['/posts/one', '/posts/one'])
  })

  it('reports a refused read as no data', async () => {
    const dashboard = fakeDashboard({
      archetype: () => Response.json({ statusCode: 409, message: 'not ready', data: { reason: 'record_not_ready' } }, { status: 409 }),
    })

    const stats = await reader(dashboard.fetch).pageStats({ page: '/posts/one', siteId: 's_example' })

    expect(stats._tag).toBe('NoData')
  })
})
