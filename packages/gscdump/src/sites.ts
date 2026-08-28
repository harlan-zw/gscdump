export {
  addSite,
  deleteSite,
  deleteSitemap,
  fetchSitemap,
  fetchSitemaps,
  fetchSites,
  fetchSitesWithSitemaps,
  submitSitemap,
} from './api/sites'
export type { FetchSitesWithSitemapsOptions } from './api/sites'
export {
  getVerificationToken,
  getVerifiedSite,
  listVerifiedSites,
  resolveVerificationTarget,
  siteUrlToVerificationSite,
  unverifySite,
  verificationMethodsFor,
  verifySite,
} from './api/verification'
export type { VerificationMethod, VerificationSite, VerificationToken, VerificationWebResource } from './core/client'
export type { ApiSite, ApiSitemap, Site } from './core/types'
