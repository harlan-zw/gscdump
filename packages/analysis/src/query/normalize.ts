// Canonical form for grouping similar search queries: unicode-folded,
// lowercased, separators stripped, synonyms collapsed, singularized via
// `pluralize` (tech-term skip list), then bag-of-words sorted — except `X to Y`
// conversions, whose word order is preserved.

/// <reference path="./pluralize.d.ts" />

import pluralize from 'pluralize'

const SYNONYMS: Record<string, string> = {
  // validation-related
  checker: 'validator',
  tester: 'validator',
  verifier: 'validator',
  verify: 'validate',
  check: 'validate',
  test: 'validate',
  checking: 'validate',
  testing: 'validate',
  // generation-related
  creator: 'generator',
  builder: 'generator',
  maker: 'generator',
  create: 'generate',
  build: 'generate',
  make: 'generate',
  // search-related
  lookup: 'search',
  finder: 'search',
  find: 'search',
  // strip these — no grouping value
  online: '',
  free: '',
}

const NO_STRIP_S = new Set([
  // short words where stripping breaks meaning
  'css',
  'js',
  'ts',
  'os',
  'as',
  'is',
  'us',
  'has',
  'was',
  'its',
  'this',
  'yes',
  'no',
  'bus',
  'gas',
  'dns',
  'rss',
  'sms',
  'gps',
  'aws',
  'sas',
  'cms',
  'ios',
  // -ss
  'less',
  'loss',
  'miss',
  'pass',
  'class',
  'access',
  'process',
  'express',
  'address',
  'cross',
  'press',
  'stress',
  'progress',
  'success',
  'business',
  'wordpress',
  // -us
  'status',
  'radius',
  'nexus',
  'focus',
  'bonus',
  'campus',
  'census',
  'corpus',
  'nucleus',
  'stimulus',
  'terminus',
  'versus',
  'virus',
  'surplus',
  'cactus',
  // -is
  'analysis',
  'basis',
  'thesis',
  'crisis',
  'axis',
  'genesis',
  'synopsis',
  'diagnosis',
  'emphasis',
  'hypothesis',
  'synthesis',
  'parenthesis',
  'redis',
  'apis',
  // -os
  'chaos',
  'demos',
  'logos',
  'photos',
  'videos',
  // tech names (word+js/ts)
  'nuxtjs',
  'nextjs',
  'nodejs',
  'reactjs',
  'vuejs',
  'angularjs',
  'expressjs',
  'nestjs',
  'threejs',
  'alpinejs',
  'solidjs',
  'sveltejs',
  'dejs',
  'bunjs',
  'denojs',
  // misc
  'canvas',
  'atlas',
  'alias',
  'bias',
  'perhaps',
  'whereas',
  'kubernetes',
  'sass',
  'postgres',
  'always',
  'across',
  'previous',
  'various',
  'serious',
  'famous',
  'anonymous',
  'continuous',
  'dangerous',
  'generous',
  'obvious',
  'numerous',
  'curious',
  'nervous',
  'conscious',
])

// Query vocabularies repeat heavily even when raw queries are distinct. Keep a
// small generational cache around the comparatively expensive English
// inflector; the hard cap prevents unbounded growth in long-lived Workers.
const DEPLURALIZED_CACHE_MAX = 4096
const depluralizedCache = new Map<string, string>()

function depluralize(token: string): string {
  // Short tokens and curated tech terms (css, redis, kubernetes, postgres, …)
  // are protected: `pluralize` is English-rule-based and would mangle domain
  // jargon it doesn't know. Everything else goes through the library's
  // singularizer, which handles irregulars (analyses→analysis), -ies/-ses/-xes,
  // and uncountables (series, news) far more correctly than hand-rolled rules.
  // `-sis` words are Greek-origin singulars (oasis, nemesis, basis, analysis)
  // whose plural is `-ses`, never themselves plural — pluralize mangles some
  // (oasis→oasi), so guard the whole ending generically.
  if (token.length <= 3 || NO_STRIP_S.has(token) || token.endsWith('sis'))
    return token
  const last = token.charCodeAt(token.length - 1)
  // `pluralize` only models English words; numeric and non-Latin tokens pass
  // through unchanged, so avoid paying its rule-engine cost for them.
  if (last < 97 || last > 122)
    return token
  const cached = depluralizedCache.get(token)
  if (cached !== undefined)
    return cached
  const singular = pluralize.singular(token)
  if (depluralizedCache.size >= DEPLURALIZED_CACHE_MAX)
    depluralizedCache.clear()
  depluralizedCache.set(token, singular)
  return singular
}

const SEPARATOR_RE = /[-_/.@#:+,;!?()[\]]+/g
// Quotes never separate words: `"keyword checker` is the same query as
// `keyword checker` (a searcher who typed one quote), and `don't` must stay one
// token rather than split into `don t`.
const QUOTE_RE = /["'\u2018\u2019\u201C\u201D`]+/g
const WHITESPACE_RE = /\s+/g
const DIACRITICS_RE = /\p{Diacritic}/gu

/**
 * Algorithm version. Bump on ANY behaviour change (synonyms, depluralize,
 * folding) so downstream stores can record which version produced a
 * `query_canonical` and detect/repair staleness on a rule change instead of
 * silently mixing old and new keys. v1 = the original ASCII heuristic;
 * v2 adds Unicode folding, the empty-canonical guard, and `pluralize`-based
 * singularization. v3 drops quotes and treats sentence punctuation
 * (`, ; ! ? ( ) [ ]`) as separators, so a stray `"` or `?` no longer keeps a
 * query out of its canonical bucket.
 */
export const NORMALIZER_VERSION = 3

/**
 * Fold to a script-neutral base so accented and full-width variants of the same
 * query group together. NFKD decomposes compatibility forms (full-width
 * `ｓｅｏ` → `seo`, ligatures) and splits diacritics off their base letter
 * (`café` → `cafe`), which we then strip. Idempotent on already-ASCII input.
 */
function foldUnicode(s: string): string {
  // Search queries are overwhelmingly ASCII. Avoid allocating a normalized
  // copy and running a Unicode-property replacement when normalization cannot
  // change the input; non-ASCII text still takes the full NFKD path.
  let index = 0
  while (index < s.length && s.charCodeAt(index) <= 0x7F)
    index++
  if (index === s.length)
    return s
  return s.normalize('NFKD').replace(DIACRITICS_RE, '')
}

// Asymmetric connectors where word order carries meaning (conversion /
// direction): `a to b` ≠ `b to a`. Symmetric connectors (`vs`, `and`, `or`)
// are intentionally absent — comparisons read the same either way and should
// still merge under the sort.
const DIRECTIONAL_CONNECTORS = new Set(['to', 'into', '>', '→'])

// Words that make a following `to` a non-directional idiom ("how to", "guide
// to", "best way to") rather than an `X to Y` conversion. Stored singular
// because the check runs on already-depluralized tokens.
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

// True when a directional connector sits as a real infix (a content token on
// each side) whose left neighbour isn't an idiom word — i.e. an `X to Y`
// conversion whose order must be preserved rather than alphabetised. Symmetric
// `vs` and idiomatic `how to …` fall through to the sort and keep merging.
function isOrderSensitive(tokens: readonly string[]): boolean {
  for (let i = 1; i < tokens.length - 1; i++) {
    if (DIRECTIONAL_CONNECTORS.has(tokens[i]!) && !NON_DIRECTIONAL_BEFORE.has(tokens[i - 1]!))
      return true
  }
  return false
}

/**
 * Produce a canonical form of a search query for grouping near-duplicates.
 * Idempotent: `normalizeQuery(normalizeQuery(q)) === normalizeQuery(q)`.
 */
export function normalizeQuery(query: string): string {
  const normalized = foldUnicode(query)
    .toLowerCase()
    .replace(QUOTE_RE, '')
    .replace(SEPARATOR_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim()
  if (normalized.length === 0)
    return ''

  // Whitespace was collapsed and trimmed above, so split cannot produce an
  // empty token. Build the synonym/depluralization output in one pass instead
  // of materializing filter/map/filter/map intermediates for every query.
  const cleaned = normalized.split(' ')
  const mapped: string[] = []
  // Synonym map; a few tokens map to '' (noise words: free / online).
  for (const token of cleaned) {
    const synonym = SYNONYMS[token] ?? token
    if (synonym)
      mapped.push(depluralize(synonym))
  }
  // Empty-canonical guard: if stripping noise emptied the query (e.g.
  // "free online"), keep the original tokens. Emitting '' would collapse every
  // noise-only query into one meaningless group and force a downstream fallback.
  const tokens = mapped.length > 0 ? mapped : cleaned.map(depluralize)
  // Bag-of-words grouping (sort) EXCEPT for `X to Y` conversions, where order is
  // meaning. See ADR-0019.
  return (isOrderSensitive(tokens) ? tokens : tokens.sort()).join(' ')
}
