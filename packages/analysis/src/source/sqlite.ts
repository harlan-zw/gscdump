import type { EngineConfig } from '@gscdump/engine-sqlite'

export type { SqliteQueryExecutor } from '@gscdump/engine-sqlite'
export { createEngine as createSqliteQuerySource } from '@gscdump/engine-sqlite'

export type SqliteQuerySourceOptions = EngineConfig
