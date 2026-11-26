export { classifyQueryIntent, encodeIntent, INTENT_CLASSIFIER_VERSION, SEARCH_INTENT_CODE } from './query/intent'
export type { IntentClassification, SearchIntent } from './query/intent'
export { normalizeQuery, NORMALIZER_VERSION } from './query/normalize'
export {
  damerauLevenshteinBounded,
  foldCanonicalTypos,
  resolveCanonicalTypoFolds,
  TYPO_FOLD_VERSION,
} from './query/typo-fold'
export type { TypoFoldInput, TypoFoldMatch, TypoFoldOptions, TypoFoldResult } from './query/typo-fold'
