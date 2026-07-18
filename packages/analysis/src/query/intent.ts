// Lexical search-intent classifier: maps a raw query to a primary intent
// (informational / commercial / transactional / unknown) plus a `howTo` flag,
// from keyword cues. A pure, deterministic function of the query string, so it
// belongs in the versioned query dimension alongside the canonical (ADR-0020).
//
// Runs on the RAW query (lightly folded), NOT the canonical: `normalizeQuery`
// strips exactly the words that carry intent (`free`, noise) and sorts tokens,
// which would destroy the signal.
//
// Brand / navigational intent is deliberately excluded — it is per-tenant and
// mutable (the user edits brand terms), so it stays a query-time concern.

export const INTENT_CLASSIFIER_VERSION = 1

export type SearchIntent = 'transactional' | 'commercial' | 'informational' | 'unknown'

export interface IntentClassification {
  /** Primary intent, by priority transactional > commercial > informational. */
  intent: SearchIntent
  /** Procedural sub-signal of informational ("how to …"). */
  howTo: boolean
  /** Matched cue tokens/phrases, for explainability + debugging. */
  signals: readonly string[]
}

// Cheap integer encoding for storage in the query dimension: the primary intent
// lives in the low 2 bits, the `howTo` flag in bit 2 — one small int (0..6) per
// distinct query instead of a string. Stable codes; never renumber (it would
// silently reinterpret stored values). Add new intents with new codes.
export const SEARCH_INTENT_CODE: Record<SearchIntent, number> = {
  unknown: 0,
  informational: 1,
  commercial: 2,
  transactional: 3,
}
const INTENT_BY_CODE: readonly SearchIntent[] = ['unknown', 'informational', 'commercial', 'transactional']
const HOWTO_BIT = 0b100

/** Pack a classification into one small int for cheap dimension storage. */
export function encodeIntent(c: Pick<IntentClassification, 'intent' | 'howTo'>): number {
  return SEARCH_INTENT_CODE[c.intent] | (c.howTo ? HOWTO_BIT : 0)
}

/** Inverse of {@link encodeIntent}. */
export function decodeIntent(code: number): { intent: SearchIntent, howTo: boolean } {
  return { intent: INTENT_BY_CODE[code & 0b011] ?? 'unknown', howTo: (code & HOWTO_BIT) !== 0 }
}

// Knowledge-seeking cues (interrogatives + info nouns).
const INFORMATIONAL = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'which',
  'whose',
  'whom',
  'guide',
  'tutorial',
  'example',
  'examples',
  'meaning',
  'definition',
  'define',
  'explained',
  'explain',
  'tip',
  'idea',
  'learn',
  'basics',
  'intro',
  'introduction',
  'overview',
  'cheatsheet',
  'documentation',
  'docs',
  'faq',
])

// Investigation / comparison cues (researching options before acting).
const COMMERCIAL = new Set([
  'best',
  'top',
  'vs',
  'versus',
  'review',
  'comparison',
  'compare',
  'alternative',
  'alternatives',
  'cheapest',
  'recommended',
  'popular',
])

// Act / buy cues.
const TRANSACTIONAL = new Set([
  'buy',
  'price',
  'pricing',
  'cost',
  'cheap',
  'coupon',
  'deal',
  'discount',
  'order',
  'purchase',
  'download',
  'subscribe',
  'subscription',
  'signup',
  'trial',
  'demo',
  'install',
  'free',
  'sale',
  'quote',
  'checkout',
  'cart',
])

// Multi-word cues matched against the spacing-normalized text.
const PHRASE_CUES: ReadonlyArray<{ re: RegExp, intent: Exclude<SearchIntent, 'unknown'> }> = [
  { re: /\bfor sale\b/, intent: 'transactional' },
  { re: /\bsign up\b/, intent: 'transactional' },
  { re: /\bnear me\b/, intent: 'transactional' },
  { re: /\bhow much\b/, intent: 'transactional' },
]

const SEPARATOR_RE = /[-_/.@#:+]+/g
const WHITESPACE_RE = /\s+/g
const DIACRITICS_RE = /\p{Diacritic}/gu

function tokenize(query: string): { text: string, tokens: string[] } {
  let index = 0
  while (index < query.length && query.charCodeAt(index) <= 0x7F)
    index++
  const folded = index === query.length
    ? query
    : query.normalize('NFKD').replace(DIACRITICS_RE, '')
  const text = folded
    .toLowerCase()
    .replace(SEPARATOR_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim()
  return { text, tokens: text.length === 0 ? [] : text.split(' ') }
}

/**
 * Classify the search intent of a raw query from lexical cues. Deterministic;
 * version it (`INTENT_CLASSIFIER_VERSION`) and bump on any rule change so a
 * materialized `intent` can detect staleness, like the canonical normalizer.
 */
export function classifyQueryIntent(query: string): IntentClassification {
  const { text, tokens } = tokenize(query)
  const signals: string[] = []
  let transactional = false
  let commercial = false
  let informational = false

  for (const t of tokens) {
    // Sets are disjoint, so each token contributes to at most one category.
    if (TRANSACTIONAL.has(t)) {
      transactional = true
      signals.push(t)
    }
    else if (COMMERCIAL.has(t)) {
      commercial = true
      signals.push(t)
    }
    else if (INFORMATIONAL.has(t)) {
      informational = true
      signals.push(t)
    }
  }

  for (const { re, intent } of PHRASE_CUES) {
    if (re.test(text)) {
      signals.push(re.source)
      if (intent === 'transactional')
        transactional = true
    }
  }

  const howTo = /\bhow to\b/.test(text)
  if (howTo)
    informational = true

  const intent: SearchIntent = transactional
    ? 'transactional'
    : commercial
      ? 'commercial'
      : informational
        ? 'informational'
        : 'unknown'

  return { intent, howTo, signals }
}
