// Write-time URL normalization. The storage layer indexes pages by pathname
// so read queries don't have to strip the origin at filter time. GSC returns
// full URLs for URL-prefix properties; we collapse them to pathname+search here
// before persisting so `url = '/foo'` works regardless of site prefix style.

const URL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i

export function normalizeUrl(input: string): string {
  if (!input)
    return input
  if (!URL_PROTOCOL_RE.test(input))
    return input.startsWith('/') ? input : `/${input}`
  const parsed = safeParse(input)
  if (!parsed)
    return input
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

function safeParse(input: string): URL | null {
  try {
    return new URL(input)
  }
  catch {
    return null
  }
}
