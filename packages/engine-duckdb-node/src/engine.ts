/**
 * DuckDB-Node engine: wraps the append-only Parquet storage engine as a
 * {@link SqlQuerySource}. `queryRows` runs typed builder-state queries;
 * `executeSql` delegates to `engine.runSQL` with `{{FILES}}` substitution
 * so SQL-native analyzers dispatch uniformly via `runAnalyzerFromSource`.
 */

import type { StorageEngine, TenantCtx } from '@gscdump/engine/contracts'
import type { SqlQuerySource } from '@gscdump/engine/resolver'
import { createEngineQuerySource } from '@gscdump/engine/source'

export interface EngineConfig {
  engine: StorageEngine
  ctx: TenantCtx
}

export function createEngine(config: EngineConfig): SqlQuerySource {
  return createEngineQuerySource(config)
}
