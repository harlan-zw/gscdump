import type {
  GoogleSearchConsoleClient,
  VerificationMethod,
  VerificationSite,
  VerificationToken,
  VerificationWebResource,
} from '../core/client'

const SC_DOMAIN_PREFIX = 'sc-domain:'

/**
 * Resolve a Search Console site URL (`https://example.com/` or
 * `sc-domain:example.com`) to the Site Verification API's site shape.
 */
export function siteUrlToVerificationSite(siteUrl: string): VerificationSite {
  if (siteUrl.startsWith(SC_DOMAIN_PREFIX))
    return { type: 'INET_DOMAIN', identifier: siteUrl.slice(SC_DOMAIN_PREFIX.length) }
  return { type: 'SITE', identifier: siteUrl }
}

/**
 * Methods valid for a given site shape. SITE properties can use META/FILE/
 * ANALYTICS/TAG_MANAGER; INET_DOMAIN must use DNS_TXT or DNS_CNAME.
 */
export function verificationMethodsFor(site: VerificationSite): VerificationMethod[] {
  if (site.type === 'INET_DOMAIN')
    return ['DNS_TXT', 'DNS_CNAME']
  return ['META', 'FILE', 'ANALYTICS', 'TAG_MANAGER']
}

/**
 * Get the verification token Google expects to find on the site or DNS.
 */
export async function getVerificationToken(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  method: VerificationMethod,
): Promise<VerificationToken & { site: VerificationSite }> {
  const site = siteUrlToVerificationSite(siteUrl)
  const res = await client.verification.getToken({ site, verificationMethod: method })
  return { ...res, site }
}

/**
 * Trigger Google to validate the placed token. Caller is responsible for
 * having placed the token (HTML tag / file / DNS record) before calling.
 */
export async function verifySite(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  method: VerificationMethod,
): Promise<VerificationWebResource> {
  const site = siteUrlToVerificationSite(siteUrl)
  return client.verification.insert({ site, verificationMethod: method })
}

/**
 * List all verified WebResources for the authed user.
 */
export async function listVerifiedSites(
  client: GoogleSearchConsoleClient,
): Promise<VerificationWebResource[]> {
  return client.verification.list()
}

/**
 * Fetch a single verified WebResource by id.
 */
export async function getVerifiedSite(
  client: GoogleSearchConsoleClient,
  id: string,
): Promise<VerificationWebResource> {
  return client.verification.get(id)
}

/**
 * Drop the calling user's verified ownership of a WebResource. The placed
 * verification token (meta tag / file / DNS record) MUST be removed first,
 * otherwise Google may auto-re-verify and the call will fail. Other owners
 * on the property are unaffected.
 */
export async function unverifySite(
  client: GoogleSearchConsoleClient,
  id: string,
): Promise<void> {
  return client.verification.delete(id)
}
