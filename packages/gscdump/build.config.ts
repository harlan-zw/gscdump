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
      input: ['./src/shared/index.ts'],
      outDir: './dist',
      name: 'shared',
    },
    {
      type: 'bundle',
      input: ['./src/shared/analysis.ts'],
      outDir: './dist',
      name: 'shared-analysis',
    },
    {
      type: 'bundle',
      input: ['./src/shared/driver.ts'],
      outDir: './dist',
      name: 'shared-driver',
    },
    {
      type: 'bundle',
      input: ['./src/shared/snapshot.ts'],
      outDir: './dist',
      name: 'shared-snapshot',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/index.ts'],
      outDir: './dist',
      name: 'analytics',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/contracts.ts'],
      outDir: './dist',
      name: 'analytics-contracts',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/planner.ts'],
      outDir: './dist',
      name: 'analytics-planner',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/schema.ts'],
      outDir: './dist',
      name: 'analytics-schema',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/tenant.ts'],
      outDir: './dist',
      name: 'analytics-tenant',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/normalize.ts'],
      outDir: './dist',
      name: 'analytics-normalize',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/ingest.ts'],
      outDir: './dist',
      name: 'analytics-ingest',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/sql-bind.ts'],
      outDir: './dist',
      name: 'analytics-sql',
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
    {
      type: 'bundle',
      input: ['./src/analytics/adapters/http.ts'],
      outDir: './dist',
      name: 'analytics-http',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/adapters/hyparquet.ts'],
      outDir: './dist',
      name: 'analytics-hyparquet',
    },
    {
      type: 'bundle',
      input: ['./src/analytics/adapters/r2.ts'],
      outDir: './dist',
      name: 'analytics-r2',
    },
  ],
})
