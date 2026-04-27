// Scope parsing utilities for granted_scopes (space-separated string from Google tokeninfo).

export function hasGscReadScope(scopes: string | null | undefined): boolean {
  if (!scopes)
    return false
  return scopes.includes('webmasters.readonly') || scopes.includes('webmasters')
}

export function hasGscWriteScope(scopes: string | null | undefined): boolean {
  if (!scopes)
    return false
  // webmasters (without .readonly) is the full read+write scope.
  return scopes.includes('webmasters') && !scopes.includes('webmasters.readonly')
}

export function hasIndexingScope(scopes: string | null | undefined): boolean {
  if (!scopes)
    return false
  return scopes.includes('googleapis.com/auth/indexing')
}
