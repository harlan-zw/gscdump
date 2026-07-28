import { defineBuildConfig } from '../../scripts/build-config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/sitemap.ts',
        './src/query/index.ts',
        './src/query/plan.ts',
        './src/core/result.ts',
        './src/contracts.ts',
        './src/dates.ts',
        './src/normalize.ts',
        './src/tenant.ts',
      ],
    },
  ],
})
