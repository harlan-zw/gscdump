import type { Connector, Database } from 'db0'
import { createDatabase } from 'db0'
import { drizzle as drizzleIntegration } from 'db0/integrations/drizzle'

export type GscDb = ReturnType<typeof drizzleIntegration>

export function createGscDb(connector: Connector): { db: GscDb, db0: Database } {
  const db0 = createDatabase(connector)
  const db = drizzleIntegration(db0)
  return { db, db0 }
}
