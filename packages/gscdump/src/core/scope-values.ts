type GoogleScopesInput = string | readonly string[] | null | undefined

export const GSC_READ_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly' as const
export const GSC_WRITE_SCOPE = 'https://www.googleapis.com/auth/webmasters' as const
export const GSC_INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing' as const
export const GSC_SITE_VERIFICATION_SCOPE = 'https://www.googleapis.com/auth/siteverification' as const

function parseGoogleScopes(scopes: GoogleScopesInput): string[] {
  if (!scopes)
    return []
  if (typeof scopes === 'string')
    return scopes.split(/\s+/).map(scope => scope.trim()).filter(Boolean)
  return scopes.map(scope => scope.trim()).filter(Boolean)
}

export function hasGoogleScope(scopes: GoogleScopesInput, scope: string): boolean {
  const tokens = parseGoogleScopes(scopes)
  // Match either the fully-qualified URI or the bare suffix (some Google
  // endpoints return one form, some the other).
  const suffix = scope.replace('https://www.googleapis.com/auth/', '')
  return tokens.includes(scope) || tokens.includes(suffix)
}
