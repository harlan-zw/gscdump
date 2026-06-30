// Scope parsing utilities for granted_scopes (space-separated string from Google tokeninfo).

import { GSC_INDEXING_SCOPE, GSC_READ_SCOPE, GSC_WRITE_SCOPE, hasGoogleScope } from './scope-values'

type GoogleScopesInput = string | readonly string[] | null | undefined

export function hasGscReadScope(scopes: GoogleScopesInput): boolean {
  return hasGoogleScope(scopes, GSC_READ_SCOPE) || hasGoogleScope(scopes, GSC_WRITE_SCOPE)
}

export function hasGscWriteScope(scopes: GoogleScopesInput): boolean {
  // webmasters (without .readonly) is the full read+write scope. The presence
  // of `webmasters.readonly` alongside it does NOT disqualify write access.
  return hasGoogleScope(scopes, GSC_WRITE_SCOPE)
}

export function hasIndexingScope(scopes: GoogleScopesInput): boolean {
  return hasGoogleScope(scopes, GSC_INDEXING_SCOPE)
}
