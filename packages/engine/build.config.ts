import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts'],
    },
    {
      type: 'bundle',
      input: ['./src/contracts.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/snapshot.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/planner.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/schema.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/ingest.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/sql-bind.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/sql-fragments.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/rollups.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/entities.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/adapters/duckdb-node.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/adapters/node-harness.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/adapters/filesystem.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/adapters/http.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/adapters/hyparquet.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/adapters/r2.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/adapters/r2-manifest.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/resolver/index.ts'],
      outDir: './dist',
    },
  ],
})
