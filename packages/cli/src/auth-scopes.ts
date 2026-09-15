import {
  GSC_INDEXING_SCOPE,
  GSC_READ_SCOPE,
  GSC_SITE_VERIFICATION_SCOPE,
  GSC_WRITE_SCOPE,
  hasGoogleScope,
} from 'gscdump/client'

export function missingRequiredScopes(scopes: readonly string[], provider?: 'gscdump'): string[] {
  const required = provider === 'gscdump'
    ? [GSC_READ_SCOPE]
    : [GSC_WRITE_SCOPE, GSC_INDEXING_SCOPE, GSC_SITE_VERIFICATION_SCOPE]
  return required.filter(scope => !hasGoogleScope(scopes, scope))
}
