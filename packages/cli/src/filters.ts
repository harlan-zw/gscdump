/**
 * Dimension filter flags (`--query`, `--page`, `--country`, `--device`,
 * `--search-appearance`) parsed once into values, then built for the local
 * Store or for the live GSC API.
 *
 * `--page` becomes a `PageRef`: the Store keeps page paths, while GSC keeps
 * full URLs. Local filters compare paths. Live filters expand a path to the
 * Site's origin, or match any host of a domain property with a regex.
 *
 * Prefix syntax (bare values mean equals):
 *   ~foo contains · !~foo not contains · re:foo regex · !re:foo not regex
 *   contains:foo contains · eq:foo equals · !foo not equals
 */

import type { Dimension, Filter } from 'gscdump/query'
import { toPath } from '@gscdump/engine/ingest'
import { and } from 'gscdump/query'

export const FILTER_DIMS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const
export type FilterDim = typeof FILTER_DIMS[number]

type MatchOperator = 'equals' | 'notEquals' | 'contains' | 'notContains'
type RegexOperator = 'includingRegex' | 'excludingRegex'

/**
 * A `--page` value. `origin` is set only when the value was a full URL, so a
 * live filter can keep the host the user named.
 */
export interface PageRef {
  path: string
  origin?: string
}

export type ParsedFilter
  = | { kind: 'match', dim: Exclude<FilterDim, 'page'>, operator: MatchOperator, value: string }
    | { kind: 'page', operator: MatchOperator, page: PageRef }
    | { kind: 'regex', dim: FilterDim, operator: RegexOperator, pattern: string }

function splitOperator(raw: string): { operator: MatchOperator | RegexOperator, value: string } {
  if (raw.startsWith('!~'))
    return { operator: 'notContains', value: raw.slice(2) }
  if (raw.startsWith('!re:'))
    return { operator: 'excludingRegex', value: raw.slice(4) }
  if (raw.startsWith('!'))
    return { operator: 'notEquals', value: raw.slice(1) }
  if (raw.startsWith('~'))
    return { operator: 'contains', value: raw.slice(1) }
  if (raw.startsWith('re:'))
    return { operator: 'includingRegex', value: raw.slice(3) }
  if (raw.startsWith('contains:'))
    return { operator: 'contains', value: raw.slice(9) }
  if (raw.startsWith('eq:'))
    return { operator: 'equals', value: raw.slice(3) }
  return { operator: 'equals', value: raw }
}

/** Parse a `--page` value. A full URL keeps its origin; anything else is a path. */
export function parsePageRef(value: string): PageRef {
  if (!/^https?:\/\//i.test(value))
    return { path: value }
  const origin = URL.canParse(value) ? new URL(value).origin : undefined
  return origin ? { path: toPath(value), origin } : { path: value }
}

export function parseFilterArg(dim: FilterDim, raw: string): ParsedFilter {
  const { operator, value } = splitOperator(raw)
  if (operator === 'includingRegex' || operator === 'excludingRegex')
    return { kind: 'regex', dim, operator, pattern: value }
  if (dim === 'page')
    return { kind: 'page', operator, page: parsePageRef(value) }
  return { kind: 'match', dim, operator, value }
}

/** Parse every filter flag present in `args`. */
export function parseFilterArgs(args: Record<string, unknown>): ParsedFilter[] {
  const argName: Record<FilterDim, string> = { query: 'query', page: 'page', country: 'country', device: 'device', searchAppearance: 'search-appearance' }
  return FILTER_DIMS.flatMap((dim) => {
    const raw = args[argName[dim]] ?? args[dim]
    return raw == null || raw === '' ? [] : [parseFilterArg(dim, String(raw))]
  })
}

export function filterDimensions(filters: readonly ParsedFilter[]): Dimension[] {
  return [...new Set(filters.map(filter => filter.kind === 'page' ? 'page' : filter.dim))]
}

function leaf(dimension: FilterDim, operator: MatchOperator | RegexOperator, expression: string): Filter<any> {
  return {
    _constraints: {},
    _filters: [{ dimension, operator, expression }],
  } as unknown as Filter<any>
}

function combine(leaves: Filter<any>[]): Filter<any> | undefined {
  if (leaves.length <= 1)
    return leaves[0]
  return and(...leaves)
}

function localLeaf(filter: ParsedFilter): Filter<any> {
  if (filter.kind === 'page')
    return leaf('page', filter.operator, filter.page.path)
  return filter.kind === 'match'
    ? leaf(filter.dim, filter.operator, filter.value)
    : leaf(filter.dim, filter.operator, filter.pattern)
}

/** Filter for the local Store, which keeps page paths. */
export function toLocalFilter(filters: readonly ParsedFilter[]): Filter<any> | undefined {
  return combine(filters.map(localLeaf))
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function livePageLeaf(operator: MatchOperator, page: PageRef, siteUrl: string): Filter<any> {
  if (page.origin)
    return leaf('page', operator, `${page.origin}${page.path}`)
  if (operator === 'contains' || operator === 'notContains')
    return leaf('page', operator, page.path)
  const path = page.path.startsWith('/') ? page.path : `/${page.path}`
  // A domain property spans every host, so match the path on any of them.
  if (siteUrl.startsWith('sc-domain:'))
    return leaf('page', operator === 'equals' ? 'includingRegex' : 'excludingRegex', `^https?://[^/]+${escapeRegex(path)}$`)
  // A URL-prefix property owns its path, so expand against the full prefix.
  const prefix = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl
  return leaf('page', operator, `${prefix}${path}`)
}

/** Filter for the live GSC API, which keeps full page URLs. */
export function toLiveFilter(filters: readonly ParsedFilter[], siteUrl: string): Filter<any> | undefined {
  return combine(filters.map(filter => filter.kind === 'page'
    ? livePageLeaf(filter.operator, filter.page, siteUrl)
    : localLeaf(filter)))
}
