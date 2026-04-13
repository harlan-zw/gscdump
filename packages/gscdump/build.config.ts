import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts'],
    },
    {
      type: 'bundle',
      input: ['./src/query/index.ts'],
      outDir: './dist',
      name: 'query',
    },
    {
      type: 'bundle',
      input: ['./src/analysis/index.ts'],
      outDir: './dist',
      name: 'analysis',
    },
    {
      type: 'bundle',
      input: ['./src/driver/index.ts'],
      outDir: './dist',
      name: 'driver',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/index.ts'],
      outDir: './dist',
      name: 'analytics',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/adapters/duckdb-node.ts'],
      outDir: './dist',
      name: 'analytics-node',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/adapters/filesystem.ts'],
      outDir: './dist',
      name: 'analytics-filesystem',
    },
  ],
})
