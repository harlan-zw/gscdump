import {
  GSC_INDEXING_SCOPE,
  GSC_SITE_VERIFICATION_SCOPE,
  GSC_WRITE_SCOPE,
  hasGoogleScope,
} from 'gscdump'

export function missingRequiredScopes(scopes: readonly string[]): string[] {
  return [GSC_WRITE_SCOPE, GSC_INDEXING_SCOPE, GSC_SITE_VERIFICATION_SCOPE]
    .filter(scope => !hasGoogleScope(scopes, scope))
}
