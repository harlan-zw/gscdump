// Canonical form for grouping similar search queries:
// lowercased, separators stripped, tokens sorted, synonyms collapsed,
// trailing-s depluralized (with a hand-tuned exception list for tech terms).

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

function depluralize(token: string): string {
  if (token.length <= 3)
    return token
  if (NO_STRIP_S.has(token))
    return token
  // ies → y (queries→query)
  if (token.endsWith('ies') && token.length > 4)
    return `${token.slice(0, -3)}y`
  // ses → se after sibilants (databases→database)
  if (token.endsWith('ses') && token.length > 4)
    return token.slice(0, -1)
  // es after sh/ch/x/z (matches→match, indexes→index)
  if (token.endsWith('shes') || token.endsWith('ches') || token.endsWith('xes') || token.endsWith('zes'))
    return token.slice(0, -2)
  // simple trailing s
  if (token.endsWith('s') && !token.endsWith('ss'))
    return token.slice(0, -1)
  return token
}

const SEPARATOR_RE = /[-_/.@#:+]+/g
const WHITESPACE_RE = /\s+/g

/**
 * Produce a canonical form of a search query for grouping near-duplicates.
 * Idempotent: `normalizeQuery(normalizeQuery(q)) === normalizeQuery(q)`.
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(SEPARATOR_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(token => SYNONYMS[token] ?? token)
    .filter(Boolean)
    .map(depluralize)
    .sort()
    .join(' ')
}
