// Partner-API wire format for gscdump filters.
//
// Two filter formats round-trip through the gscdump partner API:
//   1. SDK branded `Filter<any>` (from `./query`) — `{ _filters, _groupType }`
//   2. This wire format — plain `{ type, ... }` objects
//
// Both are accepted by gscdump.com's normalizer, which coerces the wire format
// into the SDK form server-side. The helpers below produce the wire shape and
// cast to `Filter<any>` so they satisfy `BuilderState.filter`.

import type { Filter } from './query'

/**
 * Partner-API BETWEEN filter on the `date` column — the ubiquitous date
 * window every query carries.
 */
export function dateFilter(r: { start: string, end: string }): Filter<any> {
  return { type: 'between', column: 'date', from: r.start, to: r.end } as unknown as Filter<any>
}

/** Partner-API AND combinator — wraps filters in the wire-format `and` group. */
export function andFilter(...filters: unknown[]): Filter<any> {
  return { type: 'and', filters: filters.filter(f => f != null) } as unknown as Filter<any>
}
