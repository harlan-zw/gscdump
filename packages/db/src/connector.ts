import type { Connector, Database } from 'db0'
import { createDatabase } from 'db0'
import { drizzle as drizzleIntegration } from 'db0/integrations/drizzle'

/**
 * Generic drizzle instance type.
 * Works with any drizzle SQLite instance (db0, d1, better-sqlite3, etc.)
 */

export type GoogleSearchConsoleDatabase = any

export function createGoogleSearchConsoleDatabase(connector: Connector): { db: GoogleSearchConsoleDatabase, db0: Database } {
  const db0 = createDatabase(connector)
  const db = drizzleIntegration(db0)
  return { db, db0 }
}
