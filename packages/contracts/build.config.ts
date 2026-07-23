import { defineBuildConfig } from '../../scripts/build-config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts', './src/analytics.ts', './src/partner.ts', './src/archetypes.ts', './src/v1/index.ts'],
    },
  ],
})
