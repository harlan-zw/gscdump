import type { InspectionSqlDriver } from '../src/entities'
import { expectTypeOf } from 'vitest'
import { createWaSqliteDriver } from '../src/adapters/inspection-sqlite-browser'

// Subpath compiles and exposes the expected call signature. We don't run
// wa-sqlite here — it needs the wasm module + a browser/jsdom host.
expectTypeOf(createWaSqliteDriver).toBeFunction()
expectTypeOf(createWaSqliteDriver).parameter(0).toEqualTypeOf<Uint8Array | undefined>()
expectTypeOf(createWaSqliteDriver).returns.resolves.toEqualTypeOf<InspectionSqlDriver>()
