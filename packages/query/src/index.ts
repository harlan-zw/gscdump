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
  KeywordDrillDown,
  PageDrillDown,
  QueryContext,
} from './types'

// Re-export analysis functions from gscdump (API-only, no DB equivalent)
export {
  analyzeMoversAndShakers,
  detectCannibalization,
  fetchYoYComparison,
  findStrikingDistance,
} from 'gscdump'
