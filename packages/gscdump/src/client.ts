export type {
  Auth,
  AuthClient,
  AuthOptions,
  CallOptions,
  GoogleSearchConsoleClient,
  GoogleSearchConsoleClientOptions,
  QueryReturn,
  VerificationMethod,
  VerificationSite,
  VerificationSiteType,
  VerificationToken,
  VerificationWebResource,
} from './core/client'
export {
  createAuth,
  createFetch,
  DEFAULT_GSC_REQUEST_TIMEOUT_MS,
  googleSearchConsole,
} from './core/client'
export {
  GSC_INDEXING_SCOPE,
  GSC_READ_SCOPE,
  GSC_SITE_VERIFICATION_SCOPE,
  GSC_WRITE_SCOPE,
  hasGoogleScope,
} from './core/scope-values'
export { hasGscReadScope, hasGscWriteScope, hasIndexingScope } from './core/scopes'
