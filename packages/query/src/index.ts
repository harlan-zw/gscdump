// Providers
export { createApiProvider } from './api-provider'

export { createDbProvider } from './db-provider'
// Factory
export { createProvider } from './factory'

// Types
export type {
  CreateProviderOptions,
  DataProvider,
  DataSource,
  FetchKeywordResult,
  FetchPageResult,
  QueryContext,
} from './types'

// Re-export analysis functions from gscdump (API-only, no DB equivalent)
export {
  analyzeCannibalization,
  analyzeContentDecay,
  analyzeMoversAndShakers,
  analyzeStrikingDistance,
  analyzeZeroClickQueries,
  fetchYoYComparison,
} from 'gscdump'
