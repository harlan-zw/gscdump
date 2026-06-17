/**
 * Real-API e2e for the new `sites.add/delete` + verification surface.
 *
 * Hits the live Google APIs using BYOK env vars. Only read / non-mutating
 * paths are exercised — no `sites.add`, no `sites.delete`, no
 * `verification.insert`. Those would persist state on the user's GSC account.
 *
 * Skips automatically when no BYOK is configured. Run via:
 *   GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=... \
 *   pnpm test:e2e sites-real
 *
 * Or with a raw bearer:
 *   GSC_ACCESS_TOKEN=ya29... pnpm test:e2e sites-real
 */

import process from 'node:process'
import {
  createAuth,
  getVerificationToken,
  googleSearchConsole,
  siteUrlToVerificationSite,
  verificationMethodsFor,
} from 'gscdump/api'
import { describe, expect, it } from 'vitest'

function resolveAuth() {
  const accessToken = process.env.GSC_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN
  const clientId = process.env.GSC_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GSC_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GSC_REFRESH_TOKEN ?? process.env.GOOGLE_REFRESH_TOKEN
  if (clientId && clientSecret && refreshToken)
    return createAuth({ clientId, clientSecret, refreshToken })
  if (accessToken)
    return accessToken
  return null
}

const auth = resolveAuth()
const skip = !auth

describe.skipIf(skip)('sites — real API (read-only)', () => {
  const client = googleSearchConsole(auth!)

  it('client.sites() returns the verified site list', async () => {
    const sites = await client.sites()
    expect(Array.isArray(sites)).toBe(true)
    // The auth used for these tests should have at least one verified
    // property; if not, the rest of the suite is meaningless.
    expect(sites.length).toBeGreaterThan(0)
    for (const s of sites) {
      expect(s).toHaveProperty('siteUrl')
      expect(s).toHaveProperty('permissionLevel')
    }
  })

  it('client.sites.list() returns the same shape as client.sites()', async () => {
    const a = await client.sites()
    const b = await client.sites.list()
    expect(b.map(s => s.siteUrl).sort()).toEqual(a.map(s => s.siteUrl).sort())
  })

  it('client.sites.add and .delete are functions (not exercised — would mutate state)', () => {
    expect(typeof client.sites.add).toBe('function')
    expect(typeof client.sites.delete).toBe('function')
  })
})

describe.skipIf(skip)('verification — real API (read-only)', () => {
  const client = googleSearchConsole(auth!)

  it('verification.list returns WebResources for verified sites', async () => {
    const items = await client.verification.list()
    expect(Array.isArray(items)).toBe(true)
    if (items.length > 0) {
      const first = items[0]
      expect(first.site).toBeDefined()
      expect(first.site.type).toMatch(/^(SITE|INET_DOMAIN|ANDROID_APP)$/)
      expect(typeof first.site.identifier).toBe('string')
    }
  })

  it('getVerificationToken returns a token for the first owned site (META or DNS_TXT)', async () => {
    const sites = await client.sites()
    const owned = sites.find(s => s.permissionLevel === 'siteOwner' && s.siteUrl)
    if (!owned) {
      // No owned site to derive a token for; nothing to assert.
      return
    }

    const site = siteUrlToVerificationSite(owned.siteUrl!)
    const method = verificationMethodsFor(site)[0]
    const result = await getVerificationToken(client, owned.siteUrl!, method)

    expect(result.token).toBeTruthy()
    expect(typeof result.token).toBe('string')
    expect(result.site).toEqual(site)
    // Method echo from the API; case-insensitive sanity check.
    expect(result.method.toUpperCase()).toBe(method)
  })

  it('siteUrlToVerificationSite handles both URL-prefix and sc-domain', () => {
    expect(siteUrlToVerificationSite('https://example.com/')).toEqual({
      type: 'SITE',
      identifier: 'https://example.com/',
    })
    expect(siteUrlToVerificationSite('sc-domain:example.com')).toEqual({
      type: 'INET_DOMAIN',
      identifier: 'example.com',
    })
  })
})

describe.runIf(skip)('sites — real API (skipped: no BYOK env vars)', () => {
  it('skipped — set GSC_CLIENT_ID/SECRET/REFRESH_TOKEN or GSC_ACCESS_TOKEN to run', () => {
    expect(true).toBe(true)
  })
})
