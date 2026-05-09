import { defineBuildConfig } from 'obuild/config'

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
        './src/contracts.ts',
        './src/snapshot.ts',
        './src/planner.ts',
        './src/schema.ts',
        './src/ingest.ts',
        './src/sql-bind.ts',
        './src/sql-fragments.ts',
        './src/schedule.ts',
        './src/entities.ts',
        './src/rollups.ts',
        './src/resolver/index.ts',
        './src/analyzer/index.ts',
        './src/report/index.ts',
        './src/analysis-types.ts',
        './src/period/index.ts',
        './src/source/index.ts',
        './src/scope.ts',
        './src/arrow-utils.ts',
        './src/adapters/duckdb-node.ts',
        './src/adapters/node.ts',
        './src/adapters/filesystem.ts',
        './src/adapters/hyparquet.ts',
        './src/adapters/r2.ts',
        './src/adapters/r2-manifest.ts',
      ],
    },
  ],
})
