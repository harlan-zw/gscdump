import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts'],
    },
    {
      type: 'bundle',
      input: ['./src/api/index.ts'],
      outDir: './dist',
      name: 'api',
    },
    {
      type: 'bundle',
      input: ['./src/query/index.ts'],
      outDir: './dist',
      name: 'query',
    },
    {
      type: 'bundle',
      input: ['./src/query/plan.ts'],
      outDir: './dist',
      name: 'query-plan',
    },
    {
      type: 'bundle',
      input: ['./src/core/result.ts'],
      outDir: './dist',
      name: 'result',
    },
    {
      type: 'bundle',
      input: ['./src/contracts.ts'],
      outDir: './dist',
      name: 'contracts',
    },
    {
      type: 'bundle',
      input: ['./src/normalize.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/tenant.ts'],
      outDir: './dist',
    },
  ],
})
