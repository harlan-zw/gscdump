import { defineBuildConfig } from '../../scripts/build-config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/analytics.ts',
        './src/partner.ts',
        './src/archetypes.ts',
        './src/v1/index.ts',
        './src/v1/browser.ts',
        './src/v1/documents.ts',
        './src/v1/http.ts',
        './src/v1/realtime.ts',
        './src/v1/server.ts',
      ],
    },
  ],
})
