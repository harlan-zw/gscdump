/**
 * Deterministic typo and spacing folding over canonical queries.
 *
 * Uses greedy head-anchor folding (highest impressions first, deterministic
 * tie-breakers, no transitive chaining) with structural guards against
 * numeric/version collisions, polarity inversions, and short-token drift:
 *
 * - Spaceless match (`distance = 0`): exact match after removing spaces when
 *   spaceless length >= 5 (e.g. `wallstreethotel` -> `wall street hotel`).
 * - Bounded Damerau-Levenshtein (`distance <= 1` for length >= 6, `<= 2` for
 *   length >= 10): handles insertions, deletions, substitutions, and adjacent
 *   transpositions (`schmea` -> `schema`).
 * - Numeric signature guard: queries with differing digit runs never fold
 *   (`nuxt 3` vs `nuxt 4`, `2025` vs `2026`, `404` vs `504`).
 * - Polarity guard: queries with differing negation/comparison markers never
 *   fold (`robots index` vs `robots noindex`, `follow` vs `nofollow`).
 * - Multi-word token floor: equal-word-count edit matches must differ in at
 *   most one token, and that token must meet the length floor (`>= 5` for 1
 *   edit, `>= 8` for 2 edits), blocking short-acronym collisions like
 *   `nuxt ssr mode` vs `nuxt ssg mode`.
 */

export const TYPO_FOLD_VERSION = 1

export interface TypoFoldInput {
  canonical: string
  impressions: number
  clicks?: number
}

export interface TypoFoldOptions {
  /** Maximum Damerau-Levenshtein edit distance (default 2; automatically capped to 1 for lengths 6..9 and 0 below 6). */
  maxEditDistance?: 1 | 2
  /**
   * Maximum number of highest-impression head anchors indexed for edit-distance
   * lookups (Pass 2). Defaults to `Infinity` (index every anchor). Spaceless
   * exact matching (Pass 1) still indexes every anchor, and every input query is
   * still checked against the indexed edit anchors. Set a bound (e.g. `4_000`)
   * in memory-constrained runtimes such as Cloudflare Workers when folding 50k+
   * distinct queries.
   */
  maxEditAnchors?: number
}

export interface TypoFoldMatch {
  canonical: string
  anchor: string
  reason: 'spaceless' | 'edit'
  distance: number
}

export interface TypoFoldResult {
  mapping: Map<string, string>
  matches: TypoFoldMatch[]
}

const DIGIT_RUN_RE = /\d+/g
const WHITESPACE_RE = /\s+/g

const POLARITY_TOKENS = new Set([
  'no',
  'not',
  'non',
  'without',
  'never',
  'noindex',
  'nofollow',
  'disallow',
  'disable',
  'disabled',
  'exclude',
  'off',
  'false',
  'vs',
  'versus',
  'alternative',
])

const DIRECTIONAL_CONNECTORS = new Set(['to', 'into', '>', '→'])
const NON_DIRECTIONAL_BEFORE = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'which',
  'guide',
  'way',
  'tip',
  'intro',
  'introduction',
  'learn',
  'tutorial',
  'step',
  'reason',
  'idea',
  'example',
  'benefit',
  'need',
])

const MIN_SPACELESS_LEN = 5
const MIN_DIST1_LEN = 6
const MIN_DIST2_LEN = 10
const MIN_TOKEN_DIST1_LEN = 5
const MIN_TOKEN_DIST2_LEN = 8
const MIN_CROSS_WORD_SPACELESS_LEN = 8

interface Anchor {
  canonical: string
  spaceless: string
  tokens: string[]
  numSig: string
  polaritySig: string
  impressions: number
  clicks: number
}

function extractDigitSignature(s: string): string {
  const matches = s.match(DIGIT_RUN_RE)
  return matches ? matches.join('|') : ''
}

function extractPolaritySignature(tokens: readonly string[]): string {
  const found: string[] = []
  for (const t of tokens) {
    if (POLARITY_TOKENS.has(t))
      found.push(t)
  }
  if (found.length === 0)
    return ''
  found.sort()
  return [...new Set(found)].join('|')
}

let dpPrevPrev = new Uint16Array(64)
let dpPrev = new Uint16Array(64)
let dpCurr = new Uint16Array(64)

function ensureDpCapacity(needed: number): void {
  if (dpPrev.length < needed) {
    const cap = Math.max(needed, dpPrev.length * 2)
    dpPrevPrev = new Uint16Array(cap)
    dpPrev = new Uint16Array(cap)
    dpCurr = new Uint16Array(cap)
  }
}

/**
 * Bounded optimal string alignment (Damerau-Levenshtein) distance.
 * Treats adjacent transpositions as a single edit and exits early with
 * `maxDist + 1` whenever the distance cannot be `<= maxDist`.
 */
export function damerauLevenshteinBounded(a: string, b: string, maxDist: number): number {
  if (a === b)
    return 0
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > maxDist)
    return maxDist + 1
  if (la === 0)
    return lb <= maxDist ? lb : maxDist + 1
  if (lb === 0)
    return la <= maxDist ? la : maxDist + 1

  ensureDpCapacity(lb + 1)
  let prevPrev = dpPrevPrev
  let prev = dpPrev
  let curr = dpCurr
  for (let j = 0; j <= lb; j++)
    prev[j] = j

  for (let i = 1; i <= la; i++) {
    curr[0] = i
    let rowMin = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1)
      const cost = ca === cb ? 0 : 1
      let val = prev[j]! + 1
      const ins = curr[j - 1]! + 1
      if (ins < val)
        val = ins
      const sub = prev[j - 1]! + cost
      if (sub < val)
        val = sub
      if (
        i > 1
        && j > 1
        && ca === b.charCodeAt(j - 2)
        && a.charCodeAt(i - 2) === cb
      ) {
        const trans = prevPrev[j - 2]! + 1
        if (trans < val)
          val = trans
      }
      curr[j] = val
      if (val < rowMin)
        rowMin = val
    }
    if (rowMin > maxDist)
      return maxDist + 1
    const tmp = prevPrev
    prevPrev = prev
    prev = curr
    curr = tmp
  }

  return prev[lb]! <= maxDist ? prev[lb]! : maxDist + 1
}

function addToIndex<T>(index: Map<string, T[]>, key: string, item: T): void {
  const list = index.get(key)
  if (list)
    list.push(item)
  else
    index.set(key, [item])
}

function delete1Keys(s: string): string[] {
  const keys = new Set<string>()
  keys.add(s)
  for (let i = 0; i < s.length; i++)
    keys.add(s.slice(0, i) + s.slice(i + 1))
  return [...keys]
}

function trigrams(s: string): string[] {
  const seen = new Set<string>()
  for (let i = 0; i <= s.length - 3; i++)
    seen.add(s.slice(i, i + 3))
  return [...seen]
}

function sortedCharSignature(s: string): string {
  return s.split('').sort().join('')
}

/**
 * Returns true when `target` is an exact concatenation of a permutation of
 * `pieces` (used to match compound queries like `wallstreethotel` against
 * bag-of-words-sorted canonicals like `hotel street wall`).
 */
function canTileExact(target: string, pieces: readonly string[]): boolean {
  if (pieces.length === 0)
    return target.length === 0
  if (pieces.length > 6)
    return false
  const used = new Uint8Array(pieces.length)
  const dfs = (offset: number, remaining: number): boolean => {
    if (remaining === 0)
      return offset === target.length
    for (let i = 0; i < pieces.length; i++) {
      if (used[i])
        continue
      const piece = pieces[i]!
      if (target.startsWith(piece, offset)) {
        used[i] = 1
        if (dfs(offset + piece.length, remaining - 1))
          return true
        used[i] = 0
      }
    }
    return false
  }
  return dfs(0, pieces.length)
}

/**
 * Candidate spaceless concatenations for cross-word matching. Bag-of-words
 * canonicalization sorts tokens alphabetically (`nina jirachi` -> `jirachi nina`),
 * so for 2-token queries we include both join orders (`a+b` and `b+a`).
 */
function spacelessForms(tokens: readonly string[], spaceless: string): string[] {
  if (tokens.length === 2 && tokens[0] !== tokens[1])
    return [spaceless, `${tokens[1]}${tokens[0]}`]
  return [spaceless]
}

/**
 * True when `tokens` reflects an order-preserved directional query (either
 * non-sorted order or an infix directional connector like `X to Y`).
 */
function isOrderPreservedTokens(tokens: readonly string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i - 1]! > tokens[i]!)
      return true
  }
  for (let i = 1; i < tokens.length - 1; i++) {
    if (DIRECTIONAL_CONNECTORS.has(tokens[i]!) && !NON_DIRECTIONAL_BEFORE.has(tokens[i - 1]!))
      return true
  }
  return false
}

function isSpacelessCompoundMatch(anchor: Anchor, tokens: readonly string[], spaceless: string): boolean {
  if (anchor.spaceless === spaceless)
    return true
  if (anchor.tokens.length === tokens.length)
    return false
  // Directional queries preserve word order; never tile arbitrary permutations (e.g. `jpgto png` vs `png to jpg`).
  if (isOrderPreservedTokens(anchor.tokens) || isOrderPreservedTokens(tokens))
    return false
  if (anchor.tokens.length > tokens.length)
    return canTileExact(spaceless, anchor.tokens)
  return canTileExact(anchor.spaceless, tokens)
}

function leaveOneTokenEntries(tokens: readonly string[]): Array<{ restKey: string, omitted: string }> {
  if (tokens.length < 2)
    return []
  const seen = new Set<string>()
  const out: Array<{ restKey: string, omitted: string }> = []
  for (let i = 0; i < tokens.length; i++) {
    const omitted = tokens[i]!
    if (omitted.length < MIN_TOKEN_DIST1_LEN)
      continue
    const restKey = [...tokens.slice(0, i), ...tokens.slice(i + 1)].sort().join('\x01')
    const dedupe = `${restKey}\x02${omitted}`
    if (seen.has(dedupe))
      continue
    seen.add(dedupe)
    out.push({ restKey, omitted })
  }
  return out
}

function positionalSingleTokenDiff(a: readonly string[], b: readonly string[]): [string, string] | null {
  let diffIdx = -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (diffIdx !== -1)
        return null
      diffIdx = i
    }
  }
  if (diffIdx === -1)
    return null
  return [a[diffIdx]!, b[diffIdx]!]
}

function multisetSingleTokenDiff(a: readonly string[], b: readonly string[]): [string, string] | null {
  const counts = new Map<string, number>()
  for (const t of a)
    counts.set(t, (counts.get(t) ?? 0) + 1)

  let extraB: string | null = null
  for (const t of b) {
    const c = counts.get(t) ?? 0
    if (c > 0) {
      if (c === 1)
        counts.delete(t)
      else
        counts.set(t, c - 1)
    }
    else {
      if (extraB !== null)
        return null
      extraB = t
    }
  }

  // Zero differing tokens on unequal canonicals means normalizeQuery intentionally
  // preserved directional order (e.g. `png to jpg` vs `jpg to png`) — never fold.
  if (extraB === null || counts.size !== 1)
    return null
  const [extraA, remaining] = counts.entries().next().value!
  if (remaining !== 1)
    return null
  return [extraA, extraB]
}

/**
 * True when every token of `smaller` appears (with at least the same multiplicity)
 * in `larger`. Used to block cross-word edit folding when the only difference is
 * inserting/dropping standalone short words (e.g. `nuxt docs` vs `nuxt ui docs`,
 * `nuxt image` vs `nuxt og image`), which are distinct topics rather than
 * compound-spacing typos.
 */
function isTokenMultisetSubset(smaller: readonly string[], larger: readonly string[]): boolean {
  const counts = new Map<string, number>()
  for (const t of larger)
    counts.set(t, (counts.get(t) ?? 0) + 1)
  for (const t of smaller) {
    const c = counts.get(t) ?? 0
    if (c === 0)
      return false
    counts.set(t, c - 1)
  }
  return true
}

function allowedEditDistance(lenA: number, lenB: number, maxEditDistance: 1 | 2): number {
  const minLen = Math.min(lenA, lenB)
  if (minLen < MIN_DIST1_LEN)
    return 0
  if (minLen < MIN_DIST2_LEN)
    return 1
  return maxEditDistance
}

function matchAnchorEdit(
  anchor: Anchor,
  canonical: string,
  spaceless: string,
  tokens: readonly string[],
  maxEditDistance: 1 | 2,
): number | null {
  if (anchor.tokens.length === tokens.length) {
    if (tokens.length === 1) {
      const limit = allowedEditDistance(anchor.canonical.length, canonical.length, maxEditDistance)
      if (limit === 0)
        return null
      const dist = damerauLevenshteinBounded(anchor.canonical, canonical, limit)
      return dist <= limit ? dist : null
    }
    // Multi-word same token count: require positional diff for directional queries
    // so `html to markdwon` never folds into `markdown to html`; use multiset diff
    // for bag-of-words canonicals whose typo shifts sort position.
    const diff = (isOrderPreservedTokens(anchor.tokens) || isOrderPreservedTokens(tokens))
      ? positionalSingleTokenDiff(anchor.tokens, tokens)
      : multisetSingleTokenDiff(anchor.tokens, tokens)
    if (!diff)
      return null
    const [aTok, bTok] = diff
    const minTokLen = Math.min(aTok.length, bTok.length)
    const tokLimit = minTokLen >= MIN_TOKEN_DIST2_LEN
      ? maxEditDistance
      : minTokLen >= MIN_TOKEN_DIST1_LEN
        ? 1
        : 0
    if (tokLimit === 0)
      return null
    const dist = damerauLevenshteinBounded(aTok, bTok, tokLimit)
    return dist <= tokLimit ? dist : null
  }

  // Different word counts (spacing + typo combined, e.g. `ninajirachi` vs `nina jiraci`):
  // block pure extra-word insertions (e.g. `nuxt image` vs `nuxt og image`), and
  // compare spaceless forms (including reversed 2-token order after bag-of-words sort)
  // with a strict minimum length floor.
  const [smaller, larger] = anchor.tokens.length < tokens.length
    ? [anchor.tokens, tokens]
    : [tokens, anchor.tokens]
  if (isTokenMultisetSubset(smaller, larger))
    return null
  const minSpaceless = Math.min(anchor.spaceless.length, spaceless.length)
  if (minSpaceless < MIN_CROSS_WORD_SPACELESS_LEN)
    return null
  const limit = minSpaceless >= MIN_DIST2_LEN ? maxEditDistance : 1
  const anchorForms = spacelessForms(anchor.tokens, anchor.spaceless)
  const queryForms = spacelessForms(tokens, spaceless)
  let best: number | null = null
  for (const af of anchorForms) {
    for (const qf of queryForms) {
      const dist = damerauLevenshteinBounded(af, qf, limit)
      if (dist <= limit && (best === null || dist < best))
        best = dist
    }
  }
  return best
}

function compareAnchorPriority(a: Anchor, b: Anchor): number {
  return b.impressions - a.impressions
    || b.clicks - a.clicks
    || (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0)
}

/**
 * Resolve deterministic typo/spacing folds across canonical query entries.
 * Returns both the total `canonical -> anchor` mapping and the list of folded
 * pairs with match metadata.
 */
export function resolveCanonicalTypoFolds(
  entries: readonly TypoFoldInput[],
  options: TypoFoldOptions = {},
): TypoFoldResult {
  const maxEditDistance: 1 | 2 = options.maxEditDistance ?? 2

  // Aggregate duplicate canonicals so input ordering never affects anchor order.
  const aggregated = new Map<string, { canonical: string, impressions: number, clicks: number }>()
  for (const entry of entries) {
    const canonical = entry.canonical.trim()
    if (!canonical)
      continue
    const existing = aggregated.get(canonical)
    if (existing) {
      existing.impressions += entry.impressions
      existing.clicks += entry.clicks ?? 0
    }
    else {
      aggregated.set(canonical, {
        canonical,
        impressions: entry.impressions,
        clicks: entry.clicks ?? 0,
      })
    }
  }

  const sorted = [...aggregated.values()].sort(
    (a, b) => b.impressions - a.impressions
      || b.clicks - a.clicks
      || (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0),
  )

  const maxEditAnchors = options.maxEditAnchors ?? Number.POSITIVE_INFINITY
  const mapping = new Map<string, string>()
  const matches: TypoFoldMatch[] = []
  let editAnchorsIndexed = 0

  const compoundSigIndex = new Map<string, Anchor[]>()
  const singleWordDelete1Index = new Map<string, Anchor[]>()
  const singleWordTrigramIndex = new Map<string, Anchor[]>()
  const multiWordDelete1Index = new Map<string, Anchor[]>()
  const multiWordTrigramIndex = new Map<string, Anchor[]>()
  const tokenDelete1Index = new Map<string, Anchor[]>()
  const tokenTrigramIndex = new Map<string, Anchor[]>()

  for (const item of sorted) {
    const canonical = item.canonical
    const tokens = canonical.split(WHITESPACE_RE).filter(Boolean)
    const isSingleWord = tokens.length === 1
    const spaceless = tokens.join('')
    const compoundSig = spaceless.length >= MIN_SPACELESS_LEN ? sortedCharSignature(spaceless) : ''
    const forms = spacelessForms(tokens, spaceless)
    const numSig = extractDigitSignature(canonical)
    const polaritySig = extractPolaritySignature(tokens)

    let bestAnchor: Anchor | null = null
    let bestReason: 'spaceless' | 'edit' = 'edit'
    let bestDistance = Number.POSITIVE_INFINITY

    // Pass 1: exact spaceless or token-tiling compound match (distance 0) for length >= 5.
    if (compoundSig) {
      const spacelessCandidates = compoundSigIndex.get(compoundSig)
      if (spacelessCandidates) {
        for (const anchor of spacelessCandidates) {
          if (anchor.numSig !== numSig || anchor.polaritySig !== polaritySig)
            continue
          if (!isSpacelessCompoundMatch(anchor, tokens, spaceless))
            continue
          if (!bestAnchor || compareAnchorPriority(anchor, bestAnchor) < 0) {
            bestAnchor = anchor
            bestReason = 'spaceless'
            bestDistance = 0
          }
        }
      }
    }

    // Pass 2: bounded Damerau-Levenshtein against indexed candidate anchors.
    if (!bestAnchor && spaceless.length >= MIN_DIST1_LEN) {
      const candidateSet = new Set<Anchor>()

      if (isSingleWord) {
        // Single-word queries match single-word typos and multi-word compound+typos.
        for (const dk of delete1Keys(spaceless)) {
          const singleBucket = singleWordDelete1Index.get(dk)
          if (singleBucket) {
            for (const anchor of singleBucket)
              candidateSet.add(anchor)
          }
          const multiBucket = multiWordDelete1Index.get(dk)
          if (multiBucket) {
            for (const anchor of multiBucket)
              candidateSet.add(anchor)
          }
        }

        if (maxEditDistance >= 2 && spaceless.length >= MIN_DIST2_LEN) {
          const minTrigramHits = spaceless.length <= 11 ? 1 : 2
          const hitCounts = new Map<Anchor, number>()
          for (const tg of trigrams(spaceless)) {
            for (const index of [singleWordTrigramIndex, multiWordTrigramIndex]) {
              const bucket = index.get(tg)
              if (!bucket)
                continue
              for (const anchor of bucket) {
                if (Math.abs(anchor.spaceless.length - spaceless.length) > 2)
                  continue
                const next = (hitCounts.get(anchor) ?? 0) + 1
                hitCounts.set(anchor, next)
                if (next >= minTrigramHits)
                  candidateSet.add(anchor)
              }
            }
          }
        }
      }
      else {
        // Multi-word queries: key same-word-count lookups by (rest, edit-key(omitted))
        // so brand-heavy queries sharing a short token (`nuxt <w>`) stay O(1).
        for (const { restKey, omitted } of leaveOneTokenEntries(tokens)) {
          for (const dk of delete1Keys(omitted)) {
            const bucket = tokenDelete1Index.get(`${restKey}\x02${dk}`)
            if (bucket) {
              for (const anchor of bucket)
                candidateSet.add(anchor)
            }
          }
          if (maxEditDistance >= 2 && omitted.length >= MIN_TOKEN_DIST2_LEN) {
            const minTokHits = omitted.length <= 11 ? 1 : 2
            const hitCounts = new Map<Anchor, number>()
            for (const tg of trigrams(omitted)) {
              const bucket = tokenTrigramIndex.get(`${restKey}\x03${tg}`)
              if (!bucket)
                continue
              for (const anchor of bucket) {
                const next = (hitCounts.get(anchor) ?? 0) + 1
                hitCounts.set(anchor, next)
                if (next >= minTokHits)
                  candidateSet.add(anchor)
              }
            }
          }
        }

        // Cross-word spacing + typo: check 1-delete neighborhood over spaceless forms
        // (O(1) buckets) and single-word trigram index (never collides multi-word vs multi-word).
        for (const form of forms) {
          for (const dk of delete1Keys(form)) {
            const singleBucket = singleWordDelete1Index.get(dk)
            if (singleBucket) {
              for (const anchor of singleBucket)
                candidateSet.add(anchor)
            }
            const multiBucket = multiWordDelete1Index.get(dk)
            if (multiBucket) {
              for (const anchor of multiBucket) {
                if (anchor.tokens.length !== tokens.length)
                  candidateSet.add(anchor)
              }
            }
          }
        }

        if (maxEditDistance >= 2 && spaceless.length >= MIN_DIST2_LEN) {
          const minTrigramHits = spaceless.length <= 11 ? 1 : 2
          for (const form of forms) {
            const hitCounts = new Map<Anchor, number>()
            for (const tg of trigrams(form)) {
              const bucket = singleWordTrigramIndex.get(tg)
              if (!bucket)
                continue
              for (const anchor of bucket) {
                if (Math.abs(anchor.spaceless.length - spaceless.length) > 2)
                  continue
                const next = (hitCounts.get(anchor) ?? 0) + 1
                hitCounts.set(anchor, next)
                if (next >= minTrigramHits)
                  candidateSet.add(anchor)
              }
            }
          }
        }
      }

      for (const anchor of candidateSet) {
        if (anchor.numSig !== numSig || anchor.polaritySig !== polaritySig)
          continue
        const dist = matchAnchorEdit(anchor, canonical, spaceless, tokens, maxEditDistance)
        if (dist === null)
          continue
        if (
          dist < bestDistance
          || (dist === bestDistance && (!bestAnchor || compareAnchorPriority(anchor, bestAnchor) < 0))
        ) {
          bestAnchor = anchor
          bestReason = 'edit'
          bestDistance = dist
        }
      }
    }

    if (bestAnchor) {
      mapping.set(canonical, bestAnchor.canonical)
      matches.push({
        canonical,
        anchor: bestAnchor.canonical,
        reason: bestReason,
        distance: bestDistance,
      })
      continue
    }

    // Register as a new head anchor (unmatched canonicals never chain transitively).
    const anchor: Anchor = {
      canonical,
      spaceless,
      tokens,
      numSig,
      polaritySig,
      impressions: item.impressions,
      clicks: item.clicks,
    }
    mapping.set(canonical, canonical)

    if (compoundSig)
      addToIndex(compoundSigIndex, compoundSig, anchor)
    if (editAnchorsIndexed >= maxEditAnchors)
      continue
    editAnchorsIndexed += 1
    if (isSingleWord) {
      if (spaceless.length >= MIN_DIST1_LEN) {
        for (const dk of delete1Keys(spaceless))
          addToIndex(singleWordDelete1Index, dk, anchor)
      }
      if (maxEditDistance >= 2 && spaceless.length >= MIN_DIST2_LEN) {
        for (const tg of trigrams(spaceless))
          addToIndex(singleWordTrigramIndex, tg, anchor)
      }
    }
    else {
      if (spaceless.length >= MIN_DIST1_LEN) {
        for (const form of forms) {
          for (const dk of delete1Keys(form))
            addToIndex(multiWordDelete1Index, dk, anchor)
        }
      }
      if (maxEditDistance >= 2 && spaceless.length >= MIN_DIST2_LEN && tokens.length === 2) {
        for (const form of forms) {
          for (const tg of trigrams(form))
            addToIndex(multiWordTrigramIndex, tg, anchor)
        }
      }
      for (const { restKey, omitted } of leaveOneTokenEntries(tokens)) {
        for (const dk of delete1Keys(omitted))
          addToIndex(tokenDelete1Index, `${restKey}\x02${dk}`, anchor)
        if (maxEditDistance >= 2 && omitted.length >= MIN_TOKEN_DIST2_LEN) {
          for (const tg of trigrams(omitted))
            addToIndex(tokenTrigramIndex, `${restKey}\x03${tg}`, anchor)
        }
      }
    }
  }

  return { mapping, matches }
}

/**
 * Convenience helper returning only the `canonical -> anchor` map.
 */
export function foldCanonicalTypos(
  entries: readonly TypoFoldInput[],
  options: TypoFoldOptions = {},
): Map<string, string> {
  return resolveCanonicalTypoFolds(entries, options).mapping
}
