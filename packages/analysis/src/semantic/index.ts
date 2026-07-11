export {
  analyzeContentGap,
  ContentGapSourceUnsupportedError,
  cosineNormalized,
  createContentGapAnalyzer,
  deriveUrlText,
  normalizeUrl,
  rankContentGaps,
} from './content-gap'
export type {
  ContentGapAnalysis,
  ContentGapAnalyzer,
  ContentGapOptions,
  ContentGapProgress,
  ContentGapResult,
  CreateContentGapAnalyzerOptions,
} from './content-gap'
export { createMemoryContentGapCache } from './content-gap-embeddings'
export type { ContentGapEmbeddingCache, ContentGapEmbeddingRuntime } from './content-gap-embeddings'
