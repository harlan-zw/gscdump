/**
 * `resolveTarget()` — stub day-one resolver. Future versions can wire in
 * fuzzy matching / embedding similarity / a manifest cache without
 * changing the contract.
 *
 * Today: case-insensitive exact match, falling back to substring (LIKE %x%)
 * over a caller-supplied candidate list.
 */

export type ResolveTargetKind = 'page' | 'query'

export interface ResolveTargetInput {
  kind: ResolveTargetKind
  input: string
  /**
   * Pool to resolve against. Empty pool ⇒ caller trusts the input verbatim
   * (resolver returns it as `exact`). Useful when the caller doesn't have
   * a candidate list yet but knows the value is correct.
   */
  candidates?: readonly string[]
}

export interface ResolveTargetResult {
  /** Best exact match from `candidates` (case-insensitive), or trusted input when no candidates were supplied. */
  exact: string | null
  /** All candidates that include the input as a substring (case-insensitive). Includes `exact` if matched. */
  matches: string[]
  /** True when no candidates matched at all. */
  unresolved: boolean
}

export function resolveTarget(opts: ResolveTargetInput): ResolveTargetResult {
  const needle = opts.input.trim()
  if (!needle)
    return { exact: null, matches: [], unresolved: true }

  const candidates = opts.candidates
  if (!candidates || candidates.length === 0) {
    // No pool — trust caller. Surface as `exact` so downstream filters can
    // proceed; smarter resolution can land later without breaking callers.
    return { exact: needle, matches: [needle], unresolved: false }
  }

  const lower = needle.toLowerCase()
  let exact: string | null = null
  const matches: string[] = []
  for (const c of candidates) {
    const cl = c.toLowerCase()
    if (cl === lower) {
      exact = c
      if (!matches.includes(c))
        matches.unshift(c)
      continue
    }
    if (cl.includes(lower))
      matches.push(c)
  }
  return { exact, matches, unresolved: matches.length === 0 }
}
