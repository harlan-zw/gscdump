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
      input: ['./src/query/plan.ts'],
      outDir: './dist',
      name: 'query-plan',
    },
    {
      type: 'bundle',
      input: ['./src/contracts.ts'],
      outDir: './dist',
      name: 'contracts',
    },
    {
      type: 'bundle',
      input: ['./src/driver.ts'],
      outDir: './dist',
      name: 'driver',
    },
    {
      type: 'bundle',
      input: ['./src/tenant.ts'],
      outDir: './dist',
      name: 'tenant',
    },
    {
      type: 'bundle',
      input: ['./src/normalize.ts'],
      outDir: './dist',
      name: 'normalize',
    },
    {
      type: 'bundle',
      input: ['./src/url.ts'],
      outDir: './dist',
      name: 'url',
    },
    {
      type: 'bundle',
      input: ['./src/sitemap.ts'],
      outDir: './dist',
      name: 'sitemap',
    },
    {
      type: 'bundle',
      input: ['./src/onboarding.ts'],
      outDir: './dist',
      name: 'onboarding',
    },
  ],
})
