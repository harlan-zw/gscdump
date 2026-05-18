// Scope parsing utilities for granted_scopes (space-separated string from Google tokeninfo).

const WEBMASTERS_READ = 'https://www.googleapis.com/auth/webmasters.readonly'
const WEBMASTERS_WRITE = 'https://www.googleapis.com/auth/webmasters'
const INDEXING = 'https://www.googleapis.com/auth/indexing'

function tokenize(scopes: string | null | undefined): string[] {
  if (!scopes)
    return []
  return scopes.split(/\s+/).filter(Boolean)
}

function hasScope(scopes: string | null | undefined, scope: string): boolean {
  const tokens = tokenize(scopes)
  // Match either the fully-qualified URI or the bare suffix (some Google
  // endpoints return one form, some the other).
  const suffix = scope.replace('https://www.googleapis.com/auth/', '')
  return tokens.includes(scope) || tokens.includes(suffix)
}

export function hasGscReadScope(scopes: string | null | undefined): boolean {
  return hasScope(scopes, WEBMASTERS_READ) || hasScope(scopes, WEBMASTERS_WRITE)
}

export function hasGscWriteScope(scopes: string | null | undefined): boolean {
  // webmasters (without .readonly) is the full read+write scope. The presence
  // of `webmasters.readonly` alongside it does NOT disqualify write access.
  return hasScope(scopes, WEBMASTERS_WRITE)
}

export function hasIndexingScope(scopes: string | null | undefined): boolean {
  return hasScope(scopes, INDEXING)
}
