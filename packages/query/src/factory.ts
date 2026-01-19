import type { DataProvider, ProviderOptions } from './types'
import { createApiProvider } from './api-provider'
import { createDbProvider } from './db-provider'
import { createHybridProvider } from './hybrid-provider'

/**
 * Creates a data provider based on what's provided:
 * - `{ auth }` - API only, fetches directly from Google Search Console
 * - `{ db }` - DB only, reads from local database (errors if data missing)
 * - `{ auth, db }` - Hybrid, uses DB as cache, syncs from API when data missing
 */
export function createProvider(opts: ProviderOptions): DataProvider {
  const { auth, db } = opts

  if (!auth && !db)
    throw new Error('Must provide auth, db, or both')

  // Hybrid: DB as cache, sync from API on miss
  if (auth && db)
    return createHybridProvider(auth, db)

  // API only
  if (auth)
    return createApiProvider(auth)

  // DB only
  return createDbProvider(db!)
}
