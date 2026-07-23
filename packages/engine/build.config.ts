import { fileURLToPath } from 'node:url'
import { defineBuildConfig } from '../../scripts/build-config'

// Pure-JS `hysnappy` shim. `icebird`'s metadata path pulls in
// `hyparquet-compressors`, which instantiates a WASM snappy module at import
// time — banned by `workerd`. Aliasing `hysnappy` to this shim swaps the WASM
// codec for `hyparquet`'s pure-JS snappy. Inert while `icebird` is externalized
// (the default), but keeps the engine bundle Worker-safe if it is ever inlined.
// The gscdump.com Worker bundle applies the same alias via `nuxt.config.ts`.
const hysnappyShim = fileURLToPath(new URL('./src/vendor/hysnappy-purejs.ts', import.meta.url))

// Single bundle entry with all inputs. Previously each subpath ran its own
// rolldown invocation + dts generation, and the type graph (drizzle-orm,
// hyparquet, the engine's own resolver) got walked 22 times. That's what was
// pushing publish OOM on the GitHub-hosted runner. One entry = one shared
// type pass, with rolldown emitting per-input chunks under `dist/`.
export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/errors.ts',
        './src/contracts.ts',
        './src/planner.ts',
        './src/schema.ts',
        './src/sync-config.ts',
        './src/ingest.ts',
        './src/ingest-accumulator.ts',
        './src/sink-node.ts',
        './src/sql-bind.ts',
        './src/sql-fragments.ts',
        './src/entity-keys.ts',
        './src/entities.ts',
        './src/rollups.ts',
        './src/iceberg/index.ts',
        './src/resolver/index.ts',
        './src/analyzer/index.ts',
        './src/report/index.ts',
        './src/analysis-types.ts',
        './src/period/index.ts',
        './src/source/index.ts',
        './src/scope.ts',
        './src/arrow-utils.ts',
        './src/vendor/hysnappy-purejs.ts',
        './src/adapters/node.ts',
        './src/adapters/filesystem.ts',
        './src/adapters/hyparquet.ts',
        './src/adapters/r2.ts',
      ],
      rolldown: {
        resolve: {
          alias: { hysnappy: hysnappyShim },
        },
      },
    },
  ],
})
