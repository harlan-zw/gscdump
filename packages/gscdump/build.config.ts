import { defineBuildConfig } from '../../scripts/build-config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/bing/index.ts',
        './src/client.ts',
        './src/indexing.ts',
        './src/query/index.ts',
        './src/query/plan.ts',
        './src/errors.ts',
        './src/core/result.ts',
        './src/contracts.ts',
        './src/dates.ts',
        './src/normalize.ts',
        './src/sitemap-identity.ts',
        './src/sites.ts',
        './src/tenant.ts',
      ],
    },
  ],
})
